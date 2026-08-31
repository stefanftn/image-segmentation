using ImageSeg.Domain.Images.Entities;
using ImageSeg.Domain.Images.Enums;
using ImageSeg.Domain.Images.Exceptions;
using ImageSeg.Domain.Images.Interfaces;
using ImageSeg.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace ImageSeg.Infrastructure.Images.Repositories;

/// <summary>
/// Spec §2.4, §4. Implements IImageTaskRepository against Postgres via EF Core. Two distinct
/// write styles live here on purpose:
///
/// - <see cref="AddAsync"/> and <see cref="DeleteWithGroupsAsync"/> are ordinary tracked-entity
///   writes - there is exactly one row (plus its MaskGroup children on delete) involved, so
///   there is no benefit to a set-based statement.
/// - <see cref="ClaimBatchAsync"/>, <see cref="UpdateStateAsync"/>, <see cref="CompleteAsync"/>,
///   <see cref="FailAsync"/>, and <see cref="SweepStaleAsync"/> are all set-based - no entity
///   load, guarded directly in the SQL WHERE clause on the legal-predecessor set from
///   <see cref="ImageTaskStateMachine"/>. This is the same <c>ExecuteUpdateAsync</c> approach
///   that won the old system's state-writer benchmark (spec, non-goals), now simply how this
///   repository writes state rather than a separate swappable strategy.
/// </summary>
public sealed class ImageTaskRepository : IImageTaskRepository
{
    private readonly AppDbContext _db;

    public ImageTaskRepository(AppDbContext db) => _db = db;

    public async Task AddAsync(ImageTask task, CancellationToken ct)
    {
        _db.ImageTasks.Add(task);
        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            throw new DuplicateIdempotencyKeyException(task.IdempotencyKey ?? "");
        }
    }

    public Task<ImageTask?> GetByIdAsync(Guid id, CancellationToken ct)
        => _db.ImageTasks.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct);

    public Task<ImageTask?> GetByIdempotencyKeyAsync(string idempotencyKey, CancellationToken ct)
        => _db.ImageTasks.AsNoTracking().FirstOrDefaultAsync(t => t.IdempotencyKey == idempotencyKey, ct);

    public async Task<IReadOnlyList<ImageTask>> ListByOwnerAsync(
        string ownerId, ImageOperation? operation, ImageTaskState? state, int take, CancellationToken ct)
    {
        var query = _db.ImageTasks.AsNoTracking().Where(t => t.OwnerId == ownerId);

        if (operation is not null) query = query.Where(t => t.Operation == operation);
        if (state is not null) query = query.Where(t => t.State == state);

        return await query
            .OrderByDescending(t => t.CreatedAtUtc)
            .Take(take)
            .ToListAsync(ct);
    }

    /// <summary>
    /// Spec §4.1: a single UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) ... RETURNING
    /// statement. Doing the claim, lease-set, and row read in one round trip is what makes the
    /// "commit immediately, releasing the row lock while the soft lease protects it afterward"
    /// semantics hold without an explicit transaction block here - a single statement is its
    /// own atomic unit.
    /// </summary>
    public async Task<IReadOnlyList<ImageTask>> ClaimBatchAsync(int batchSize, TimeSpan leaseDuration, DateTime utcNow, CancellationToken ct)
    {
        var lockedUntil = utcNow.Add(leaseDuration);

        const string sql = """
            UPDATE "ImageTasks" t
            SET "LockedUntilUtc" = @lockedUntil
            FROM (
                SELECT "Id" FROM "ImageTasks"
                WHERE "State" = 'Pending'
                  AND ("LockedUntilUtc" IS NULL OR "LockedUntilUtc" < @now)
                ORDER BY "CreatedAtUtc"
                LIMIT @batchSize
                FOR UPDATE SKIP LOCKED
            ) claimable
            WHERE t."Id" = claimable."Id"
            RETURNING t.*;
            """;

        return await _db.ImageTasks
            .FromSqlRaw(sql,
                new NpgsqlParameter("lockedUntil", lockedUntil),
                new NpgsqlParameter("now", utcNow),
                new NpgsqlParameter("batchSize", batchSize))
            .AsNoTracking()
            .ToListAsync(ct);
    }

    public async Task<bool> UpdateStateAsync(Guid id, ImageTaskState next, DateTime utcNow, CancellationToken ct)
    {
        var predecessors = ImageTaskStateMachine.AllowedPredecessors(next);

        var affected = await _db.ImageTasks
            .Where(t => t.Id == id && predecessors.Contains(t.State))
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.State, next)
                .SetProperty(t => t.UpdatedAtUtc, utcNow), ct);

        return affected > 0;
    }

    public async Task<bool> CompleteAsync(Guid id, string resultFilePath, DateTime utcNow, CancellationToken ct)
    {
        var predecessors = ImageTaskStateMachine.AllowedPredecessors(ImageTaskState.Completed);

        var affected = await _db.ImageTasks
            .Where(t => t.Id == id && predecessors.Contains(t.State))
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.State, ImageTaskState.Completed)
                .SetProperty(t => t.UpdatedAtUtc, utcNow)
                .SetProperty(t => t.ResultFilePath, resultFilePath), ct);

        return affected > 0;
    }

    public async Task<bool> FailAsync(Guid id, string errorMessage, DateTime utcNow, CancellationToken ct)
    {
        var predecessors = ImageTaskStateMachine.AllowedPredecessors(ImageTaskState.Failed);

        var affected = await _db.ImageTasks
            .Where(t => t.Id == id && predecessors.Contains(t.State))
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.State, ImageTaskState.Failed)
                .SetProperty(t => t.UpdatedAtUtc, utcNow)
                .SetProperty(t => t.ErrorMessage, errorMessage), ct);

        return affected > 0;
    }

    public async Task<IReadOnlyList<Guid>> SweepStaleAsync(DateTime cutoffUtc, int batchSize, string errorMessage, DateTime utcNow, CancellationToken ct)
    {
        var stale = await _db.ImageTasks.AsNoTracking()
            .Where(t => t.State != ImageTaskState.Completed
                     && t.State != ImageTaskState.Failed
                     && t.UpdatedAtUtc < cutoffUtc)
            .OrderBy(t => t.UpdatedAtUtc)
            .Take(batchSize)
            .Select(t => t.Id)
            .ToListAsync(ct);

        if (stale.Count == 0) return Array.Empty<Guid>();

        // Set-based and idempotent: the non-terminal guard means a task that completed between
        // the SELECT and this UPDATE is left alone.
        var ids = stale.ToArray();
        await _db.ImageTasks
            .Where(t => ids.Contains(t.Id) && t.State != ImageTaskState.Completed && t.State != ImageTaskState.Failed)
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.State, ImageTaskState.Failed)
                .SetProperty(t => t.ErrorMessage, errorMessage)
                .SetProperty(t => t.UpdatedAtUtc, utcNow), ct);

        return stale;
    }

    public async Task<ImageTask?> DeleteWithGroupsAsync(Guid id, string ownerId, CancellationToken ct)
    {
        var task = await _db.ImageTasks.FirstOrDefaultAsync(t => t.Id == id && t.OwnerId == ownerId, ct);
        if (task is null) return null;

        await _db.MaskGroups.Where(g => g.ImageTaskId == id).ExecuteDeleteAsync(ct);
        _db.ImageTasks.Remove(task);
        await _db.SaveChangesAsync(ct);

        return task;
    }

    private static bool IsUniqueViolation(DbUpdateException ex)
        => ex.InnerException is PostgresException { SqlState: "23505" };
}
