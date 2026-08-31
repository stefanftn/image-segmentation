using ImageSeg.Application.Images.Interfaces;
using ImageSeg.Domain.Images.Enums;
using ImageSeg.Domain.Shared.Interfaces;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Processing;

namespace ImageSeg.Application.Images.Processing;

/// <summary>
/// Spec §4.4 - third decorator. Moves the task to Preprocessing, fetches the original from
/// storage, normalises it, and hands the bytes to the inference stage.
///
/// Downscaling here is not cosmetic: it bounds both the sidecar's per-call latency and this
/// process's memory ceiling, which is what makes the in-flight limit in §4.3 a meaningful
/// resource guarantee rather than a guess.
/// </summary>
public sealed class ImagePreprocessingDecorator : ITaskProcessor
{
    private readonly ITaskProcessor _inner;
    private readonly IStorageService _storage;
    private readonly IImageTaskService _taskService;
    private readonly ProcessorOptions _options;
    private readonly ILogger<ImagePreprocessingDecorator> _logger;

    public ImagePreprocessingDecorator(
        ITaskProcessor inner,
        IStorageService storage,
        IImageTaskService taskService,
        IOptions<ProcessorOptions> options,
        ILogger<ImagePreprocessingDecorator> logger)
    {
        _inner = inner;
        _storage = storage;
        _taskService = taskService;
        _options = options.Value;
        _logger = logger;
    }

    public async Task ProcessAsync(TaskProcessingContext context, CancellationToken ct)
    {
        // Pending -> Preprocessing.
        await _taskService.AdvanceStateAsync(context.TaskId, ImageTaskState.Preprocessing, ct);

        await using var original = await _storage.DownloadAsync(context.OriginalFilePath, ct);

        using var image = await Image.LoadAsync(original, ct);
        var longestEdge = Math.Max(image.Width, image.Height);

        // Operation-specific cap: Regions' SAM encoder has a fixed internal working resolution
        // regardless of input size, so its own, lower cap avoids paying decode and
        // post-processing cost (both of which scale with pixel count) for detail the encoder
        // never uses. Segment keeps the original, higher cap.
        var maxDimension = context.Operation == ImageOperation.Regions
            ? _options.RegionsPreprocessMaxDimension
            : _options.PreprocessMaxDimension;

        if (longestEdge > maxDimension)
        {
            var scale = (double)maxDimension / longestEdge;
            var width = (int)Math.Round(image.Width * scale);
            var height = (int)Math.Round(image.Height * scale);

            image.Mutate(x => x.Resize(width, height));
            _logger.LogInformation("Downscaled image to {Width}x{Height} before inference ({Operation} cap={Cap}).",
                width, height, context.Operation, maxDimension);
        }

        // Normalised to PNG so the sidecar has exactly one input format to handle.
        using var buffer = new MemoryStream();
        await image.SaveAsync(buffer, new PngEncoder(), ct);

        context.PreprocessedImage = buffer.ToArray();
        context.PreprocessedContentType = "image/png";

        await _inner.ProcessAsync(context, ct);
    }
}
