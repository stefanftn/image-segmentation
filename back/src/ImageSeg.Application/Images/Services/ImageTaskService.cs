using ImageSeg.Application.Images.Interfaces;
using ImageSeg.Domain.Images.Entities;
using ImageSeg.Domain.Images.Enums;
using ImageSeg.Domain.Images.Exceptions;
using ImageSeg.Domain.Images.Interfaces;
using ImageSeg.Domain.Shared.Interfaces;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Prometheus;

namespace ImageSeg.Application.Images.Services;

/// <summary>
/// Spec §1, §5, §8. The one orchestration point for everything that happens to an ImageTask
/// after it leaves the controller: submission, reads, deletion, and every pipeline state
/// transition. State-changing methods always write through <see cref="IImageTaskRepository"/>
/// first and only broadcast over <see cref="ITaskStatusNotifier"/> on a successful write - never
/// the other way around, since a broadcast for a write that did not happen would show clients a
/// status the database does not actually have.
/// </summary>
public sealed class ImageTaskService : IImageTaskService
{
    private static readonly HashSet<string> ValidModes = new(StringComparer.OrdinalIgnoreCase) { "interior", "exterior" };

    // Labeled by operation ("Segment"/"Regions") and outcome ("completed"/"failed") - the one
    // pair of numbers that answers "is the pipeline actually working" without reading logs.
    private static readonly Counter TasksTotal = Metrics.CreateCounter(
        "imageseg_tasks_total", "Tasks that reached a terminal state.", "operation", "outcome");

    // End-to-end: CreatedAtUtc (submission) to UpdatedAtUtc at the terminal write - queue wait +
    // preprocessing + AI inference + result upload, all of it. Exponential buckets from 1s to
    // ~17min cover both a healthy fast path and a queue-backlog-induced slow one.
    private static readonly Histogram TaskDurationSeconds = Metrics.CreateHistogram(
        "imageseg_task_duration_seconds", "End-to-end duration from task creation to a terminal (Completed/Failed) state.",
        new HistogramConfiguration
        {
            LabelNames = new[] { "operation" },
            Buckets = Histogram.ExponentialBuckets(1, 2, 11)
        });

    private readonly IImageTaskRepository _repository;
    private readonly IStorageService _storage;
    private readonly ITaskStatusNotifier _notifier;
    private readonly UploadValidator _validator;
    private readonly TimeProvider _clock;
    private readonly ILogger<ImageTaskService> _logger;
    private readonly int _presignedUrlExpiryMinutes;

    public ImageTaskService(
        IImageTaskRepository repository,
        IStorageService storage,
        ITaskStatusNotifier notifier,
        UploadValidator validator,
        TimeProvider clock,
        IOptions<StorageOptions> storageOptions,
        ILogger<ImageTaskService> logger)
    {
        _repository = repository;
        _storage = storage;
        _notifier = notifier;
        _validator = validator;
        _clock = clock;
        _logger = logger;
        _presignedUrlExpiryMinutes = storageOptions.Value.PresignedUrlExpiryMinutes;
    }

    public async Task<SubmitImageResult> SubmitAsync(
        Stream imageStream, long imageLength, string? declaredContentType,
        string operation, string? mode, string ownerId, Guid? correlationId, string? idempotencyKey, CancellationToken ct)
    {
        if (!Enum.TryParse<ImageOperation>(operation, ignoreCase: true, out var parsedOperation))
            throw new ArgumentException("operation must be 'Segment' or 'Regions'.", nameof(operation));

        string? normalizedMode = null;
        if (parsedOperation == ImageOperation.Segment)
        {
            if (string.IsNullOrWhiteSpace(mode) || !ValidModes.Contains(mode))
                throw new ArgumentException("mode is required for operation=Segment and must be 'interior' or 'exterior'.", nameof(mode));

            normalizedMode = mode.ToLowerInvariant(); // sidecar checks the literal lowercase strings
        }

        // ---- idempotent submission, cheap pre-check --------------------------------------
        // The unique filtered index on IdempotencyKey (AppDbContext) is what actually makes
        // this safe under concurrent duplicates; this lookup just avoids paying for an upload
        // in the common, non-racing case.
        if (!string.IsNullOrWhiteSpace(idempotencyKey))
        {
            var existing = await _repository.GetByIdempotencyKeyAsync(idempotencyKey, ct);
            if (existing is not null)
            {
                _logger.LogInformation("Idempotency-Key {Key} already accepted as {RequestId}; returning existing task.",
                    idempotencyKey, existing.Id);
                return new SubmitImageResult(existing.Id, existing.CorrelationId, existing.State);
            }
        }

        // ---- validate before any storage or DB call ---------------------------------------
        UploadValidationResult validation;
        var startPosition = imageStream.CanSeek ? imageStream.Position : 0;
        validation = await _validator.ValidateAsync(imageStream, imageLength, declaredContentType, ct);
        if (!validation.IsValid)
            throw new ArgumentException(validation.Error, nameof(imageStream));

        if (imageStream.CanSeek) imageStream.Position = startPosition;

        // ---- upload, but do not commit the row until the upload succeeded -----------------
        var provider = Domain.Shared.Interfaces.StorageProviders.MinIO;

        var extension = validation.DetectedContentType switch
        {
            "image/png" => ".png",
            "image/jpeg" => ".jpg",
            "image/webp" => ".webp",
            _ => ".bin"
        };

        var storageKey = $"originals/{_clock.GetUtcNow():yyyy/MM/dd}/{Guid.NewGuid():N}{extension}";
        await _storage.UploadAsync(imageStream, storageKey, ct);

        var now = _clock.GetUtcNow().UtcDateTime;
        var task = ImageTask.Create(storageKey, provider, parsedOperation, normalizedMode, ownerId, correlationId, idempotencyKey, now);

        try
        {
            await _repository.AddAsync(task, ct);
        }
        catch (DuplicateIdempotencyKeyException)
        {
            // A concurrent request with the same Idempotency-Key won the race. Clean up our
            // now-orphaned upload and return the winner's task instead of erroring.
            await CompensateAsync(storageKey, ct);

            var winner = await _repository.GetByIdempotencyKeyAsync(idempotencyKey!, ct);
            if (winner is not null)
                return new SubmitImageResult(winner.Id, winner.CorrelationId, winner.State);

            throw;
        }
        catch (Exception ex)
        {
            await CompensateAsync(storageKey, ct);
            _logger.LogError(ex, "Failed to persist task for upload {Key}; uploaded object was compensated.", storageKey);
            throw;
        }

        return new SubmitImageResult(task.Id, task.CorrelationId, task.State);
    }

    public Task<ImageTask?> GetStatusAsync(Guid id, CancellationToken ct) => _repository.GetByIdAsync(id, ct);

    public async Task<ResultLookup?> GetResultAsync(Guid id, CancellationToken ct)
    {
        var task = await _repository.GetByIdAsync(id, ct);
        if (task is null) return null;

        if (task.State != ImageTaskState.Completed || string.IsNullOrEmpty(task.ResultFilePath))
            return new ResultLookup(null, false, task.State, task.ErrorMessage, "image/png");

        var expiry = TimeSpan.FromMinutes(_presignedUrlExpiryMinutes);
        var presigned = await _storage.GetPresignedDownloadUrlAsync(task.ResultFilePath, expiry, ct);
        return new ResultLookup(presigned, true, task.State, null, "image/png");
    }

    public async Task<ResultLookup?> GetOriginalAsync(Guid id, CancellationToken ct)
    {
        var task = await _repository.GetByIdAsync(id, ct);
        if (task is null) return null;

        var expiry = TimeSpan.FromMinutes(_presignedUrlExpiryMinutes);
        var presigned = await _storage.GetPresignedDownloadUrlAsync(task.OriginalFilePath, expiry, ct);
        return new ResultLookup(presigned, true, task.State, null, ContentTypeForKey(task.OriginalFilePath));
    }

    public async Task<IReadOnlyList<ImageSummary>> ListAsync(string ownerId, ImageOperation? operation, ImageTaskState? state, CancellationToken ct)
    {
        var tasks = await _repository.ListByOwnerAsync(ownerId, operation, state, take: 100, ct);
        return tasks.Select(t => new ImageSummary(t.Id, t.Operation, t.Mode, t.State, t.CreatedAtUtc, t.UpdatedAtUtc)).ToList();
    }

    public async Task<bool> DeleteAsync(Guid id, string ownerId, CancellationToken ct)
    {
        var deleted = await _repository.DeleteWithGroupsAsync(id, ownerId, ct);
        if (deleted is null) return false;

        // Storage cleanup happens after the DB row is gone: a failed storage delete leaves an
        // orphaned object (annoying, cheap to garbage-collect later) rather than a DB row that
        // still references objects that might already be gone (which would break /result and
        // /original with a confusing error instead of a clean 404).
        await TryDeleteStorageAsync(deleted.OriginalFilePath, ct);
        if (!string.IsNullOrEmpty(deleted.ResultFilePath))
            await TryDeleteStorageAsync(deleted.ResultFilePath, ct);

        return true;
    }

    public async Task<bool> AdvanceStateAsync(Guid id, ImageTaskState next, CancellationToken ct)
    {
        var now = _clock.GetUtcNow().UtcDateTime;
        var ok = await _repository.UpdateStateAsync(id, next, now, ct);
        if (!ok)
        {
            _logger.LogError("Rejected illegal state advance for task {TaskId} to {Next}.", id, next);
            return false;
        }

        await BroadcastAsync(id, ct);
        return true;
    }

    public async Task<bool> CompleteAsync(Guid id, string resultFilePath, CancellationToken ct)
    {
        var now = _clock.GetUtcNow().UtcDateTime;
        var ok = await _repository.CompleteAsync(id, resultFilePath, now, ct);
        if (!ok)
        {
            _logger.LogError("Rejected illegal completion for task {TaskId}.", id);
            return false;
        }

        RecordTerminal(await BroadcastAsync(id, ct));
        return true;
    }

    public async Task<bool> FailAsync(Guid id, string errorMessage, CancellationToken ct)
    {
        var now = _clock.GetUtcNow().UtcDateTime;
        var ok = await _repository.FailAsync(id, errorMessage, now, ct);
        if (!ok)
        {
            _logger.LogError("Rejected illegal failure write for task {TaskId}.", id);
            return false;
        }

        RecordTerminal(await BroadcastAsync(id, ct));
        return true;
    }

    public async Task<int> SweepStaleAsync(TimeSpan maxTaskDuration, int batchSize, CancellationToken ct)
    {
        var now = _clock.GetUtcNow().UtcDateTime;
        var cutoff = now - maxTaskDuration;

        var affected = await _repository.SweepStaleAsync(cutoff, batchSize, "Timeout: exceeded max processing duration", now, ct);
        foreach (var id in affected)
            RecordTerminal(await BroadcastAsync(id, ct));

        return affected.Count;
    }

    private async Task<ImageTask?> BroadcastAsync(Guid id, CancellationToken ct)
    {
        var task = await _repository.GetByIdAsync(id, ct);
        if (task is null) return null; // deleted between the write and this read - nothing to tell anyone

        await _notifier.NotifyStatusChangedAsync(TaskStatusSnapshot.From(task), ct);
        return task;
    }

    /// <summary>Feeds TasksTotal/TaskDurationSeconds from whatever BroadcastAsync just re-read -
    /// called from every path that can move a task into Completed/Failed (CompleteAsync,
    /// FailAsync, SweepStaleAsync), never from AdvanceStateAsync's intermediate transitions.</summary>
    private static void RecordTerminal(ImageTask? task)
    {
        if (task is null) return;
        if (task.State != ImageTaskState.Completed && task.State != ImageTaskState.Failed) return;

        var outcome = task.State == ImageTaskState.Completed ? "completed" : "failed";
        var operation = task.Operation.ToString();

        TasksTotal.WithLabels(operation, outcome).Inc();
        TaskDurationSeconds.WithLabels(operation).Observe((task.UpdatedAtUtc - task.CreatedAtUtc).TotalSeconds);
    }

    private async Task CompensateAsync(string storageKey, CancellationToken ct)
    {
        try
        {
            await _storage.DeleteAsync(storageKey, ct);
            _logger.LogInformation("Compensated orphaned upload {Key}.", storageKey);
        }
        catch (Exception cleanupEx)
        {
            _logger.LogError(cleanupEx, "Compensation failed for {Key}; object is orphaned and needs manual cleanup.", storageKey);
        }
    }

    private async Task TryDeleteStorageAsync(string key, CancellationToken ct)
    {
        try
        {
            await _storage.DeleteAsync(key, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to delete storage object {Key} during task deletion; it is now orphaned.", key);
        }
    }

    private static string ContentTypeForKey(string key) => Path.GetExtension(key).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        _ => "application/octet-stream"
    };
}

/// <summary>Storage:*  - PresignedUrlExpiryMinutes lives here since it configures a storage concern used across services.</summary>
public sealed class StorageOptions
{
    public const string SectionName = "Storage";

    /// <summary>Lifetime handed to GetPresignedDownloadUrlAsync by /result and /original.</summary>
    public int PresignedUrlExpiryMinutes { get; set; } = 15;
}
