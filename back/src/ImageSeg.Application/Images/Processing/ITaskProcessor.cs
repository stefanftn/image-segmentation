using ImageSeg.Domain.Images.Enums;

namespace ImageSeg.Application.Images.Processing;

/// <summary>
/// Unit of work flowing through the decorator pipeline (spec §4.4). Built once by
/// <see cref="TaskPoller"/> from a claimed <c>ImageTask</c> row - there is no Kafka message to
/// deserialize anymore, so this is populated directly from the entity instead of an event
/// payload.
/// </summary>
public sealed class TaskProcessingContext
{
    public required Guid TaskId { get; init; }
    public required Guid CorrelationId { get; init; }
    public required ImageOperation Operation { get; init; }
    public string? Mode { get; init; }
    public required string OriginalFilePath { get; init; }
    public required string StorageProvider { get; init; }

    /// <summary>Populated by ImagePreprocessingDecorator, consumed by AiInferenceProcessor.</summary>
    public byte[]? PreprocessedImage { get; set; }

    public string? PreprocessedContentType { get; set; }
}

/// <summary>
/// Spec §4.4. Decorator chain, built in TaskPoller:
/// LoggingProcessorDecorator -&gt; RetryProcessorDecorator -&gt; ImagePreprocessingDecorator -&gt; AiInferenceProcessor.
/// Internals carried over unchanged from the prototype - only the entry point (TaskPoller
/// instead of the Kafka consumer) differs.
/// </summary>
public interface ITaskProcessor
{
    Task ProcessAsync(TaskProcessingContext context, CancellationToken ct);
}
