namespace ImageSeg.Domain.Shared.Interfaces;

/// <summary>
/// Result of either sidecar call (spec §7). <c>ImagePng</c> is a wall MASK for Segment, or a
/// SAM "label map" (region ids as pixel values) for Regions - same PNG transport, different
/// semantic content; the caller (AiInferenceProcessor) knows which based on which method it
/// called. <c>Headers</c> carries response headers worth keeping for logging (X-Coverage-Pct,
/// X-Segment-Count, X-Elapsed-Ms, ...).
/// </summary>
public sealed record SegmentationResult(byte[] ImagePng, string ContentType, IReadOnlyDictionary<string, string> Headers);

/// <summary>
/// Spec §7. Two methods, matching the sidecar's two routes exactly. RoutingSegmentationClient
/// (Infrastructure) is the only implementation the Application layer ever resolves - it always
/// routes Segment to the local sidecar, and routes Regions to either the local sidecar or a
/// GPU-backed Colab notebook depending on config.
/// </summary>
public interface ISegmentationClient
{
    /// <summary>POST /segment - automatic wall mask via a fixed model for the given mode ("interior" | "exterior").</summary>
    Task<SegmentationResult> SegmentAsync(byte[] image, string imageContentType, string mode, Guid correlationId, CancellationToken ct);

    /// <summary>POST /regions - SAM label map for interactive, frontend-driven region selection. No mode.</summary>
    Task<SegmentationResult> GetRegionsAsync(byte[] image, string imageContentType, Guid correlationId, CancellationToken ct);
}
