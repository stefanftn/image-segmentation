using ImageSeg.Domain.Images.Entities;
using ImageSeg.Domain.Images.Enums;

namespace ImageSeg.Domain.Images.Interfaces;

/// <summary>
/// Spec §1 / §2.4 / §4. This is the one seam through which every persisted change to an
/// <see cref="ImageTask"/> flows - both the ordinary tracked-entity writes (submit, delete)
/// and the hot-path, set-based state advances the old system split into a separate
/// <c>ITaskStateWriter</c> abstraction. That split existed only to benchmark four candidate
/// write strategies; the benchmark is done, <c>ExecuteUpdateAsync</c> won, and there is no
/// remaining reason for a second interface sitting next to this one (spec, non-goals).
/// </summary>
public interface IImageTaskRepository
{
    /// <summary>Tracked insert for a newly submitted task.</summary>
    Task AddAsync(ImageTask task, CancellationToken ct);

    Task<ImageTask?> GetByIdAsync(Guid id, CancellationToken ct);

    Task<ImageTask?> GetByIdempotencyKeyAsync(string idempotencyKey, CancellationToken ct);

    Task<IReadOnlyList<ImageTask>> ListByOwnerAsync(
        string ownerId, ImageOperation? operation, ImageTaskState? state, int take, CancellationToken ct);

    /// <summary>
    /// Atomically claims up to <paramref name="batchSize"/> <c>Pending</c> tasks whose lease
    /// has expired (or was never taken), setting <c>LockedUntilUtc</c> in the same statement
    /// (spec §4.1). Implemented as <c>SELECT ... FOR UPDATE SKIP LOCKED</c> so two poller
    /// instances never claim the same row.
    /// </summary>
    Task<IReadOnlyList<ImageTask>> ClaimBatchAsync(int batchSize, TimeSpan leaseDuration, DateTime utcNow, CancellationToken ct);

    /// <summary>
    /// Set-based state advance guarded on <see cref="ImageTaskStateMachine.AllowedPredecessors"/>
    /// in the SQL WHERE clause - no entity load. Returns false (and logs, at the call site) if
    /// the row was not in a legal predecessor state, which the caller should treat as an
    /// <see cref="Exceptions.InvalidStateTransitionException"/>-equivalent condition.
    /// </summary>
    Task<bool> UpdateStateAsync(Guid id, ImageTaskState next, DateTime utcNow, CancellationToken ct);

    /// <summary>Processing -&gt; Completed, with the result key, in one set-based write.</summary>
    Task<bool> CompleteAsync(Guid id, string resultFilePath, DateTime utcNow, CancellationToken ct);

    /// <summary>Any non-terminal state -&gt; Failed, with the error message, in one set-based write.</summary>
    Task<bool> FailAsync(Guid id, string errorMessage, DateTime utcNow, CancellationToken ct);

    /// <summary>
    /// Force-fails every non-terminal task whose <c>UpdatedAtUtc</c> is older than
    /// <paramref name="cutoffUtc"/> (spec §4.5). Returns the ids actually force-failed, so the
    /// caller can broadcast their new terminal state over SignalR.
    /// </summary>
    Task<IReadOnlyList<Guid>> SweepStaleAsync(DateTime cutoffUtc, int batchSize, string errorMessage, DateTime utcNow, CancellationToken ct);

    /// <summary>
    /// Deletes the task row and every <see cref="MaskGroups.Entities.MaskGroup"/> referencing
    /// it, scoped to <paramref name="ownerId"/> (spec §8, DELETE /api/images/{id}). Returns the
    /// deleted task (so the caller can remove its storage objects) or null if no such task
    /// exists for that owner.
    /// </summary>
    Task<ImageTask?> DeleteWithGroupsAsync(Guid id, string ownerId, CancellationToken ct);
}
