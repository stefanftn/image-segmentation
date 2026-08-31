using ImageSeg.Application.Images.Interfaces;
using ImageSeg.Domain.Images.Enums;
using ImageSeg.Domain.Shared.Interfaces;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace ImageSeg.Application.Images.Processing;

/// <summary>
/// Spec §4.4 innermost stage, §7. Calls the sidecar - /segment or /regions, depending on
/// operation - uploads the returned PNG, and records its key as ResultFilePath.
///
/// Segment stores a wall MASK. Regions stores a SAM "label map" (each pixel's value is a
/// region id) - not a mask at all; the frontend derives masks from it client-side by grouping
/// region ids (see MaskGroup). Either way the backend never renders or stores an edited image;
/// colour/saturation/texture changes are composited over the original in the browser.
/// </summary>
public sealed class AiInferenceProcessor : ITaskProcessor
{
    private readonly ISegmentationClient _client;
    private readonly IStorageService _storage;
    private readonly IImageTaskService _taskService;
    private readonly SemaphoreSlim _inflight;
    private readonly ILogger<AiInferenceProcessor> _logger;

    public AiInferenceProcessor(
        ISegmentationClient client,
        IStorageService storage,
        IImageTaskService taskService,
        InFlightLimiter limiter,
        ILogger<AiInferenceProcessor> logger)
    {
        _client = client;
        _storage = storage;
        _taskService = taskService;
        _inflight = limiter.Semaphore;
        _logger = logger;
    }

    public async Task ProcessAsync(TaskProcessingContext context, CancellationToken ct)
    {
        if (context.PreprocessedImage is null)
            throw new InvalidOperationException("AiInferenceProcessor requires a preprocessed image.");

        // Preprocessing -> Processing.
        await _taskService.AdvanceStateAsync(context.TaskId, ImageTaskState.Processing, ct);

        // Bounds concurrent sidecar calls per instance (spec §4.3). TaskPoller checks this same
        // semaphore before claiming a new batch, so pressure shows up as fewer claims per cycle
        // instead of an invisible in-memory backlog.
        await _inflight.WaitAsync(ct);
        Domain.Shared.Interfaces.SegmentationResult result;
        try
        {
            var image = context.PreprocessedImage;
            var contentType = context.PreprocessedContentType ?? "image/png";

            result = context.Operation switch
            {
                ImageOperation.Segment => await _client.SegmentAsync(
                    image, contentType,
                    context.Mode ?? throw new InvalidOperationException(
                        $"Task {context.TaskId} is Operation=Segment but carries no Mode."),
                    context.CorrelationId, ct),

                ImageOperation.Regions => await _client.GetRegionsAsync(
                    image, contentType, context.CorrelationId, ct),

                _ => throw new InvalidOperationException($"Unhandled operation '{context.Operation}'.")
            };
        }
        finally
        {
            _inflight.Release();
        }

        var resultKey = context.Operation == ImageOperation.Regions
            ? $"regions/{context.TaskId:N}.png"
            : $"masks/{context.TaskId:N}.png";

        using (var stream = new MemoryStream(result.ImagePng))
        {
            await _storage.UploadAsync(stream, resultKey, ct);
        }

        // Processing -> Completed, with ResultFilePath, plus the SignalR broadcast.
        await _taskService.CompleteAsync(context.TaskId, resultKey, ct);

        _logger.LogInformation("Stored {Operation} result {ResultKey} for task {RequestId}.",
            context.Operation, resultKey, context.TaskId);
    }
}

/// <summary>
/// Owns the single semaphore that bounds in-flight sidecar calls (spec §4.3) - registered as a
/// singleton so TaskPoller and AiInferenceProcessor share the exact same instance.
/// </summary>
public sealed class InFlightLimiter
{
    public SemaphoreSlim Semaphore { get; }

    public InFlightLimiter(IOptions<ProcessorOptions> options)
    {
        Semaphore = new SemaphoreSlim(options.Value.MaxInFlightPerInstance, options.Value.MaxInFlightPerInstance);
    }
}
