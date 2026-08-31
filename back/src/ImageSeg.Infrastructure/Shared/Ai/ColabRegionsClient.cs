using System.Diagnostics;
using System.Net.Http.Headers;
using ImageSeg.Domain.Shared.Exceptions;
using ImageSeg.Domain.Shared.Interfaces;
using Microsoft.Extensions.Logging;

namespace ImageSeg.Infrastructure.Shared.Ai;

/// <summary>
/// Calls POST /regions on a GPU-backed Colab notebook reached over an ngrok tunnel, as an
/// alternative to the local CPU SAM model (spec §7). Only ever invoked by
/// RoutingSegmentationClient, and only for /regions.
///
/// Contract assumption worth restating: the multipart field must be named "image" and the
/// route must be "/regions" - a notebook copied from an early draft may still use older naming
/// and needs updating to match before this will work.
/// </summary>
public sealed class ColabRegionsClient
{
    public const string ClientName = "ai-sidecar-colab-regions";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<ColabRegionsClient> _logger;

    public ColabRegionsClient(IHttpClientFactory httpClientFactory, ILogger<ColabRegionsClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<SegmentationResult> GetRegionsAsync(byte[] image, string imageContentType, Guid correlationId, CancellationToken ct)
    {
        var http = _httpClientFactory.CreateClient(ClientName);

        if (string.IsNullOrWhiteSpace(http.BaseAddress?.ToString()))
        {
            // Fails fast with a clear cause rather than an opaque "invalid request URI" further
            // down - this is the single most likely misconfig (forgot to set
            // AiSidecar__Colab__BaseUrl after switching RegionsBackend to Colab).
            throw new ColabBackendException(
                "AiSidecar:RegionsBackend is set to 'Colab' but AiSidecar:Colab:BaseUrl is empty. " +
                "Set it to the current ngrok URL from the Colab notebook and restart the Web process.");
        }

        using var content = new MultipartFormDataContent();
        var imageContent = new ByteArrayContent(image);
        imageContent.Headers.ContentType = new MediaTypeHeaderValue(imageContentType);
        content.Add(imageContent, "image", "input" + Extension(imageContentType));

        using var request = new HttpRequestMessage(HttpMethod.Post, "/regions") { Content = content };
        request.Headers.Add("X-Correlation-Id", correlationId.ToString());

        var sw = Stopwatch.StartNew();
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct);

            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(ct);
                throw new ColabBackendException(
                    $"Colab backend returned {(int)response.StatusCode}: {Trim(body)}", statusCode: response.StatusCode);
            }

            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            sw.Stop();

            var headers = ExtractHeaders(response);

            _logger.LogInformation(
                "Colab /regions returned {Bytes} bytes in {Elapsed}ms. CorrelationId={CorrelationId}",
                bytes.Length, (int)sw.Elapsed.TotalMilliseconds, correlationId);

            return new SegmentationResult(bytes, response.Content.Headers.ContentType?.MediaType ?? "image/png", headers);
        }
        catch (ColabBackendException)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Network-level failure (tunnel down, DNS, connection refused) - wrapped so the
            // caller sees one consistent exception type regardless of which layer failed.
            throw new ColabBackendException(
                "Could not reach the Colab backend. The notebook session or ngrok tunnel may have expired.", ex);
        }
    }

    private static readonly string[] TrackedHeaders = { "X-Elapsed-Ms", "X-Segment-Count" };

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
