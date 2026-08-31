using System.Diagnostics;
using System.Net.Http.Headers;
using ImageSeg.Domain.Shared.Exceptions;
using ImageSeg.Domain.Shared.Interfaces;
using Microsoft.Extensions.Logging;

namespace ImageSeg.Infrastructure.Shared.Ai;

/// <summary>
/// Spec §7. Typed client for the LOCAL Python sidecar's POST /segment and POST /regions -
/// carried over unchanged from the prototype, no logic changes.
///
/// Uses TWO separately-named HttpClients (via IHttpClientFactory), not one shared client:
/// /segment and /regions have fundamentally different latency profiles, so they need
/// independent timeout, retry, and circuit-breaker budgets - a shared timeout sized for one
/// starves the other. Each named client's resilience pipeline is attached in Program.cs via
/// AddResilienceHandler, wrapping the HttpMessageHandler rather than living in the decorator -
/// this keeps the sidecar's failure policy separate from RetryProcessorDecorator, exactly as
/// spec §4.4 requires (their exclusion of SidecarException covers this).
/// </summary>
public sealed class LocalSegmentationClient : ISegmentationClient
{
    public const string SegmentClientName = "ai-sidecar-segment";
    public const string RegionsClientName = "ai-sidecar-regions";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<LocalSegmentationClient> _logger;

    public LocalSegmentationClient(IHttpClientFactory httpClientFactory, ILogger<LocalSegmentationClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public Task<SegmentationResult> SegmentAsync(byte[] image, string imageContentType, string mode, Guid correlationId, CancellationToken ct)
        => PostAsync(SegmentClientName, "/segment", image, imageContentType,
            extraFields: new[] { new KeyValuePair<string, string>("mode", mode) },
            correlationId, ct);

    public Task<SegmentationResult> GetRegionsAsync(byte[] image, string imageContentType, Guid correlationId, CancellationToken ct)
        => PostAsync(RegionsClientName, "/regions", image, imageContentType, extraFields: null, correlationId, ct);

    private async Task<SegmentationResult> PostAsync(
        string clientName, string path, byte[] image, string imageContentType,
        IEnumerable<KeyValuePair<string, string>>? extraFields,
        Guid correlationId, CancellationToken ct)
    {
        var http = _httpClientFactory.CreateClient(clientName);

        using var content = new MultipartFormDataContent();
        var imageContent = new ByteArrayContent(image);
        imageContent.Headers.ContentType = new MediaTypeHeaderValue(imageContentType);
        // Field name is "image" - the sidecar's FastAPI parameter is named `image: UploadFile`,
        // and FastAPI binds multipart fields by parameter name.
        content.Add(imageContent, "image", "input" + Extension(imageContentType));

        if (extraFields is not null)
            foreach (var (key, value) in extraFields)
                content.Add(new StringContent(value), key);

        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = content };
        request.Headers.Add("X-Correlation-Id", correlationId.ToString());

        var sw = Stopwatch.StartNew();
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct);

            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(ct);
                throw new SidecarException(
                    $"Sidecar returned {(int)response.StatusCode} from {path}: {Trim(body)}", null, response.StatusCode);
            }

            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            sw.Stop();

            var headers = ExtractHeaders(response);

            _logger.LogInformation(
                "Sidecar {Path} returned {Bytes} bytes in {Elapsed}ms. CorrelationId={CorrelationId}",
                path, bytes.Length, (int)sw.Elapsed.TotalMilliseconds, correlationId);

            return new SegmentationResult(bytes, response.Content.Headers.ContentType?.MediaType ?? "image/png", headers);
        }
        catch (SidecarException)
        {
            throw;
        }
        catch (Exception ex)
        {
            sw.Stop();
            // Network-level failure (connection refused, DNS, or the resilience handler's own
            // circuit-breaker/timeout wrapping around this call) - normalized to SidecarException
            // so RetryProcessorDecorator can recognize it regardless of the underlying BCL type.
            throw new SidecarException($"Failed to call sidecar {path}: {ex.Message}", ex);
        }
    }

    private static readonly string[] TrackedHeaders =
    {
        "X-Mode", "X-Coverage-Pct", "X-Elapsed-Ms", "X-Morph-Radius", "X-Min-Blob-Pct", "X-Segment-Count"
    };

    private static IReadOnlyDictionary<string, string> ExtractHeaders(HttpResponseMessage response)
    {
        var result = new Dictionary<string, string>();
        foreach (var name in TrackedHeaders)
            if (response.Headers.TryGetValues(name, out var values))
                result[name] = values.FirstOrDefault() ?? "";
        return result;
    }

    private static string Extension(string contentType) => contentType switch
    {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/webp" => ".webp",
        _ => ".bin"
    };

    private static string Trim(string s) => s.Length <= 500 ? s : s[..500];
}
