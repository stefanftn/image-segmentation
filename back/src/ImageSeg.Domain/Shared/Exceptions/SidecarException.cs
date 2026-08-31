using System.Net;

namespace ImageSeg.Domain.Shared.Exceptions;

/// <summary>
/// Base type for any failure originating from the AI sidecar HTTP call (spec §4.4, §7). Both
/// implementations of <c>ISegmentationClient</c> (Infrastructure) throw this instead of a raw
/// <see cref="HttpRequestException"/> so that <c>RetryProcessorDecorator</c> (Application) can
/// recognize "the sidecar's own resilience pipeline already gave up on this" without Application
/// referencing any Infrastructure type - only this Domain-level exception.
/// </summary>
public class SidecarException : Exception
{
    public HttpStatusCode? StatusCode { get; }

    public SidecarException(string message, Exception? inner = null, HttpStatusCode? statusCode = null)
        : base(message, inner)
    {
        StatusCode = statusCode;
    }
}

/// <summary>
/// Thrown for any failure reaching or getting a valid response from the Colab GPU backend
/// (spec §7, "clean-fail, not fallback"). Exists purely so callers can surface a specific,
/// actionable message ("check the notebook/tunnel") instead of the generic sidecar-down copy.
/// </summary>
public sealed class ColabBackendException : SidecarException
{
    public ColabBackendException(string message, Exception? inner = null, HttpStatusCode? statusCode = null)
        : base(message, inner, statusCode) { }
}
