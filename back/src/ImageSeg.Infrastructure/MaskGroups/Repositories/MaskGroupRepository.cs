using ImageSeg.Domain.MaskGroups.Entities;
using ImageSeg.Domain.MaskGroups.Interfaces;
using ImageSeg.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace ImageSeg.Infrastructure.MaskGroups.Repositories;

public sealed class MaskGroupRepository : IMaskGroupRepository
{
    private readonly AppDbContext _db;

    public MaskGroupRepository(AppDbContext db) => _db = db;

    public Task AddAsync(MaskGroup group, CancellationToken ct)
    {
        _db.MaskGroups.Add(group);
        return Task.CompletedTask;
    }

    public Task<MaskGroup?> GetAsync(Guid imageTaskId, Guid groupId, CancellationToken ct)
        => _db.MaskGroups.FirstOrDefaultAsync(g => g.Id == groupId && g.ImageTaskId == imageTaskId, ct);

    public async Task<IReadOnlyList<MaskGroup>> ListAsync(Guid imageTaskId, CancellationToken ct)
        => await _db.MaskGroups.AsNoTracking()
            .Where(g => g.ImageTaskId == imageTaskId)
            .OrderBy(g => g.CreatedAtUtc)
            .ToListAsync(ct);

    public Task SaveChangesAsync(CancellationToken ct) => _db.SaveChangesAsync(ct);

    public async Task<bool> DeleteAsync(Guid imageTaskId, Guid groupId, CancellationToken ct)
    {
        var affected = await _db.MaskGroups
            .Where(g => g.Id == groupId && g.ImageTaskId == imageTaskId)
            .ExecuteDeleteAsync(ct);
        return affected > 0;
    }

    public async Task DeleteAllForTaskAsync(Guid imageTaskId, CancellationToken ct)
        => await _db.MaskGroups.Where(g => g.ImageTaskId == imageTaskId).ExecuteDeleteAsync(ct);
}
