using ImageSeg.Domain.Images.Enums;
using ImageSeg.Domain.Images.Exceptions;

namespace ImageSeg.Domain.Images.Entities;

/// <summary>Spec §2.1.</summary>
public class ImageTask
{
    /// <summary>PK, also used as RequestId.</summary>
    public Guid Id { get; private set; } = Guid.NewGuid();

    public ImageTaskState State { get; private set; } = ImageTaskState.Pending;

    /// <summary>Which sidecar capability this task requests: <c>Segment</c> or <c>Regions</c>.</summary>
    public ImageOperation Operation { get; private set; }

    /// <summary>
    /// Required when <see cref="Operation"/> is <c>Segment</c> - "interior" or "exterior",
    /// selects which fixed model the sidecar runs. Always null for <c>Regions</c>.
    /// </summary>
    public string? Mode { get; private set; }

    /// <summary>
    /// Real FK to <c>AspNetUsers.Id</c> (spec §2.1/§3) - the ASP.NET Core Identity user that
    /// submitted this task. Scopes the "my uploaded images" listing and authorizes access to
    /// the task's saved <see cref="MaskGroups.Entities.MaskGroup"/> selections.
    /// </summary>
    public string OwnerId { get; private set; } = default!;

    /// <summary>Storage key/path returned by <c>IStorageService.UploadAsync</c>.</summary>
    public string OriginalFilePath { get; private set; } = default!;

    /// <summary>
    /// Always "MinIO" today. Kept as a recorded value (rather than a hardcoded constant) for
    /// the same reason <c>IStorageService</c> stays an interface - a second backend should
    /// cost a new implementation, not a schema migration (spec §2.1, §6).
    /// </summary>
    public string StorageProvider { get; private set; } = default!;

    /// <summary>
    /// For <c>Operation=Segment</c>: the wall MASK produced by the sidecar - never a
    /// finished/edited image. For <c>Operation=Regions</c>: the SAM "label map" (each pixel's
    /// value is the id of the region it belongs to). The backend never renders or stores an
    /// edited image; the frontend composites the final look client-side.
    /// </summary>
    public string? ResultFilePath { get; private set; }

    /// <summary>Propagated through every log line and the AI sidecar HTTP call (spec §10).</summary>
    public Guid CorrelationId { get; private set; }

    public DateTime CreatedAtUtc { get; private set; }

    /// <summary>Checked by StaleTaskSweeperWorker (spec §4.5).</summary>
    public DateTime UpdatedAtUtc { get; private set; }

    /// <summary>
    /// Soft lease for the poller claim (spec §2.1, §4.1) - moved directly onto ImageTask now
    /// that there is no separate outbox row to carry it. NULL, or in the past, means claimable.
    /// </summary>
    public DateTime? LockedUntilUtc { get; private set; }

    /// <summary>Incremented by the decorator pipeline.</summary>
    public int ProcessingAttempts { get; private set; }

    public string? ErrorMessage { get; private set; }

    /// <summary>Optional, unique index. A client retry with the same key returns the original task.</summary>
    public string? IdempotencyKey { get; private set; }

    private ImageTask() { } // EF

    public static ImageTask Create(
        string originalFilePath,
        string storageProvider,
        ImageOperation operation,
        string? mode,
        string ownerId,
        Guid? correlationId,
        string? idempotencyKey,
        DateTime utcNow)
    {
        if (operation == ImageOperation.Segment && string.IsNullOrWhiteSpace(mode))
            throw new ArgumentException("Mode is required when Operation is Segment.", nameof(mode));

        var task = new ImageTask
        {
            Id = Guid.NewGuid(),
            State = ImageTaskState.Pending,
            OriginalFilePath = originalFilePath,
            StorageProvider = storageProvider,
            Operation = operation,
            // Regions has no mode concept - normalized to null rather than trusting the
            // caller to have omitted it, so a stray value never leaks into storage.
            Mode = operation == ImageOperation.Segment ? mode : null,
            OwnerId = ownerId,
            IdempotencyKey = string.IsNullOrWhiteSpace(idempotencyKey) ? null : idempotencyKey,
            CreatedAtUtc = utcNow,
            UpdatedAtUtc = utcNow
        };
        task.CorrelationId = correlationId ?? task.Id; // defaults to Id if not supplied by the caller
        return task;
    }

    /// <summary>
    /// Enforced transition. Throws <see cref="InvalidStateTransitionException"/> on any
    /// out-of-order attempt (spec §2.4). Used by tracked-entity code paths; the hot-path
    /// repository writes (claim, state advance) use set-based <c>ExecuteUpdateAsync</c>
    /// guarded on the same predecessor set instead of loading the entity - see
    /// <see cref="ImageTaskStateMachine"/>.
    /// </summary>
    public void TransitionTo(ImageTaskState next, DateTime utcNow)
    {
        if (!ImageTaskStateMachine.CanTransition(State, next))
            throw new InvalidStateTransitionException(Id, State, next);

        State = next;
        UpdatedAtUtc = utcNow;
    }

    public void MarkCompleted(string resultFilePath, DateTime utcNow)
    {
        ResultFilePath = resultFilePath;
        TransitionTo(ImageTaskState.Completed, utcNow);
    }

    public void MarkFailed(string errorMessage, DateTime utcNow)
    {
        ErrorMessage = errorMessage;
        TransitionTo(ImageTaskState.Failed, utcNow);
    }

    public void IncrementProcessingAttempts(DateTime utcNow)
    {
        ProcessingAttempts++;
        UpdatedAtUtc = utcNow;
    }

    public void SetLease(DateTime? lockedUntilUtc)
    {
        LockedUntilUtc = lockedUntilUtc;
    }
}
