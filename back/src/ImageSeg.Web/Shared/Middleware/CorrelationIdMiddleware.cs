using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace ImageSeg.Web.Shared.Middleware;

/// <summary>
/// Spec §9, §10. First in the pipeline: generates or forwards X-Correlation-Id so the same id
/// appears on the HTTP request, in TaskPoller's processing logs, and on the sidecar HTTP call
/// for that task - the only realistic way to trace one task's path through logs without a
/// dashboard (spec's non-goals on metrics infrastructure).
/// </summary>
public sealed class CorrelationIdMiddleware
{
    public const string HeaderName = "X-Correlation-Id";

    private readonly RequestDelegate _next;
    private readonly ILogger<CorrelationIdMiddleware> _logger;

    public CorrelationIdMiddleware(RequestDelegate next, ILogger<CorrelationIdMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var incoming = context.Request.Headers[HeaderName].FirstOrDefault();

        // A client-supplied value is only honoured if it is a well-formed GUID - otherwise an
        // arbitrary header value would end up as a log attribute across every log line.
        var correlationId = Guid.TryParse(incoming, out var parsed) ? parsed : Guid.NewGuid();

        context.Request.Headers[HeaderName] = correlationId.ToString();
        context.Response.Headers[HeaderName] = correlationId.ToString();
        context.TraceIdentifier = correlationId.ToString();

        using (_logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = correlationId }))
        {
            await _next(context);
        }
    }
}
