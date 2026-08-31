using ImageSeg.Domain.Shared.Interfaces;
using Microsoft.Extensions.Options;

namespace ImageSeg.Infrastructure.Shared.Ai;

/// <summary>
/// The ISegmentationClient the Application layer actually resolves (spec §7). Everything else
/// in this namespace (LocalSegmentationClient, ColabRegionsClient) is an implementation detail
/// behind this router - Application has no idea a Colab option even exists.
///
/// Segment always goes to the local sidecar, unconditionally. Regions branches on
/// AiSidecar:RegionsBackend. This mirrors the "one interface, config picks the implementation"
/// shape already used for IStorageService (only one implementation ships, but the seam exists).
/// </summary>
public sealed class RoutingSegmentationClient : ISegmentationClient
{
    private readonly LocalSegmentationClient _local;
    private readonly ColabRegionsClient _colab;
    private readonly AiSidecarOptions _options;

    public RoutingSegmentationClient(LocalSegmentationClient local, ColabRegionsClient colab, IOptions<AiSidecarOptions> options)
    {
        _local = local;
        _colab = colab;
        _options = options.Value;
    }

    public Task<SegmentationResult> SegmentAsync(byte[] image, string imageContentType, string mode, Guid correlationId, CancellationToken ct)
        => _local.SegmentAsync(image, imageContentType, mode, correlationId, ct);

    public Task<SegmentationResult> GetRegionsAsync(byte[] image, string imageContentType, Guid correlationId, CancellationToken ct)
        => _options.RegionsBackend switch
        {
            var backend when string.Equals(backend, RegionsBackends.Colab, StringComparison.OrdinalIgnoreCase)
                => _colab.GetRegionsAsync(image, imageContentType, correlationId, ct),

            var backend when string.Equals(backend, RegionsBackends.Local, StringComparison.OrdinalIgnoreCase)
                => _local.GetRegionsAsync(image, imageContentType, correlationId, ct),

            _ => throw new InvalidOperationException(
                $"Unknown AiSidecar:RegionsBackend '{_options.RegionsBackend}'. Expected '{RegionsBackends.Local}' or '{RegionsBackends.Colab}'.")
        };
}
