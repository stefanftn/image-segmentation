using ImageSeg.Domain.Images.Entities;
using ImageSeg.Domain.Images.Enums;

namespace ImageSeg.Application.Images.Interfaces;

public sealed record SubmitImageResult(Guid RequestId, Guid CorrelationId, ImageTaskState State);

public sealed record ImageSummary(Guid RequestId, ImageOperation Operation, string? Mode, ImageTaskState State, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

/// <summary><c>IsReady</c> false + <c>State</c> non-null means "exists, not Completed yet" (409 at the controller).</summary>
public sealed record ResultLookup(string? PresignedUrl, bool IsReady, ImageTaskState State, string? ErrorMessage, string ContentType);

/// <summary>
/// Spec §1: the controller-facing surface. <c>ImagesController</c> injects only this interface,
/// never the concrete <c>ImageTaskService</c> or any Infrastructure type.
/// </summary>
public interface IImageTaskService
{
    /// <summary>
    /// Validates, uploads, and persists a new task (spec §8 POST /api/images/process). Throws
    /// <see cref="ArgumentException"/> on validation failure - the controller maps that to 400.
    /// </summary>
    Task<SubmitImageResult> SubmitAsync(
        Stream imageStream, long imageLength, string? declaredContentType,
        string operation, string? mode, string ownerId, Guid? correlationId, string? idempotencyKey, CancellationToken ct);

    Task<ImageTask?> GetStatusAsync(Guid id, CancellationToken ct);

    /// <summary>
    /// Result of a GET /result or /original lookup. <c>PresignedUrl</c> is null only when the
    /// task itself was not found; <c>IsReady</c> distinguishes "task exists but has no result
    /// yet" (result endpoint, non-terminal state) from a normal redirect.
    /// </summary>
    Task<ResultLookup?> GetResultAsync(Guid id, CancellationToken ct);

    Task<ResultLookup?> GetOriginalAsync(Guid id, CancellationToken ct);

    Task<IReadOnlyList<ImageSummary>> ListAsync(string ownerId, ImageOperation? operation, ImageTaskState? state, CancellationToken ct);

    /// <summary>Owner-scoped delete of the task row, its MaskGroups, and its storage objects (spec §8, NEW).</summary>
    Task<bool> DeleteAsync(Guid id, string ownerId, CancellationToken ct);

    // ---- Pipeline-facing state transitions (spec §5) --------------------------------------
    // The processing decorators call these instead of IImageTaskRepository directly:
    // broadcasting a SignalR update is orchestration, not persistence, and this is the one
    // place that does both a write and its corresponding push, in that order, every time.

    /// <summary>Advances state (e.g. Pending -&gt; Preprocessing, Preprocessing -&gt; Processing) and broadcasts on success.</summary>
    Task<bool> AdvanceStateAsync(Guid id, ImageTaskState next, CancellationToken ct);

    /// <summary>Processing -&gt; Completed with the result key, then broadcasts.</summary>
    Task<bool> CompleteAsync(Guid id, string resultFilePath, CancellationToken ct);

    /// <summary>Any non-terminal state -&gt; Failed with the error message, then broadcasts.</summary>
    Task<bool> FailAsync(Guid id, string errorMessage, CancellationToken ct);

    /// <summary>Force-fails stale non-terminal tasks (spec §4.5) and broadcasts each one. Returns the count affected.</summary>
    Task<int> SweepStaleAsync(TimeSpan maxTaskDuration, int batchSize, CancellationToken ct);
}
