using ImageSeg.Application.Images.Interfaces;
using ImageSeg.Domain.Images.Enums;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace ImageSeg.Web.Images.Controllers;

public sealed record ProcessImageResponse(Guid RequestId, Guid CorrelationId, string State);

public sealed record StatusResponse(
    Guid RequestId, string Operation, string? Mode, string State,
    DateTime UpdatedAtUtc, bool IsTerminal, string? ErrorMessage, string? ResultUrl);

public sealed record ImageSummaryResponse(Guid RequestId, string Operation, string? Mode, string State, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

/// <summary>
/// Spec §8. Injects only <see cref="IImageTaskService"/> - the Application-layer interface -
/// never a concrete Infrastructure type, per the dependency rule stated in spec §1.
/// </summary>
[ApiController]
[Route("api/images")]
public sealed class ImagesController : ControllerBase
{
    private readonly IImageTaskService _service;

    public ImagesController(IImageTaskService service) => _service = service;

    /// <summary>POST /api/images/process (spec §8). Always authenticated - no dev-token shortcut anywhere in this system.</summary>
    [HttpPost("process")]
    [Authorize]
    [EnableRateLimiting("writes")]
    [RequestSizeLimit(11 * 1024 * 1024)]
    public async Task<IActionResult> Process(
        [FromForm(Name = "image")] IFormFile image,
        [FromForm] string operation,
        [FromForm] string? mode,
        CancellationToken ct)
    {
        var ownerId = User.FindFirst(ClaimTypes_NameIdentifier)?.Value;
        if (string.IsNullOrWhiteSpace(ownerId))
            return Problem("Authenticated identity is missing an id claim.", statusCode: StatusCodes.Status401Unauthorized);

        var idempotencyKey = Request.Headers["Idempotency-Key"].FirstOrDefault();
        var correlationId = Guid.TryParse(Request.Headers["X-Correlation-Id"].FirstOrDefault(), out var cid) ? cid : (Guid?)null;

        try
        {
            await using var stream = image.OpenReadStream();
            var result = await _service.SubmitAsync(
                stream, image.Length, image.ContentType, operation, mode, ownerId, correlationId, idempotencyKey, ct);

            Response.Headers["Location"] = $"/api/images/{result.RequestId}/status";
            return Accepted(new ProcessImageResponse(result.RequestId, result.CorrelationId, result.State.ToString()));
        }
        catch (ArgumentException ex)
        {
            return Problem(ex.Message, statusCode: StatusCodes.Status400BadRequest);
        }
    }

    /// <summary>GET /api/images/{id}/status - unscoped, matches the spec's documented deviation (spec §8).</summary>
    [HttpGet("{id:guid}/status")]
    [AllowAnonymous]
    [EnableRateLimiting("reads")]
    public async Task<IActionResult> GetStatus(Guid id, CancellationToken ct)
    {
        var task = await _service.GetStatusAsync(id, ct);
        if (task is null) return NotFound();

        var terminal = Domain.Images.Entities.ImageTaskStateMachine.IsTerminal(task.State);
        return Ok(new StatusResponse(
            task.Id, task.Operation.ToString(), task.Mode, task.State.ToString(),
            task.UpdatedAtUtc, terminal, task.ErrorMessage,
            task.State == ImageTaskState.Completed ? $"/api/images/{id}/result" : null));
    }

    /// <summary>GET /api/images/{id}/result (spec §8) - 302 to a presigned MinIO URL, or 409 if not ready.</summary>
    [HttpGet("{id:guid}/result")]
    [AllowAnonymous]
    [EnableRateLimiting("reads")]
    public async Task<IActionResult> GetResult(Guid id, CancellationToken ct)
    {
        var lookup = await _service.GetResultAsync(id, ct);
        if (lookup is null) return NotFound();

        if (!lookup.IsReady)
            return new ObjectResult(new { requestId = id, state = lookup.State.ToString(), error = lookup.ErrorMessage, message = "Result is not available yet." })
            {
                StatusCode = StatusCodes.Status409Conflict
            };

        return Redirect(lookup.PresignedUrl!);
    }

    /// <summary>GET /api/images/{id}/original (spec §8) - available for the lifetime of the task, regardless of state.</summary>
    [HttpGet("{id:guid}/original")]
    [AllowAnonymous]
    [EnableRateLimiting("reads")]
    public async Task<IActionResult> GetOriginal(Guid id, CancellationToken ct)
    {
        var lookup = await _service.GetOriginalAsync(id, ct);
        if (lookup is null) return NotFound();

        return Redirect(lookup.PresignedUrl!);
    }

    /// <summary>GET /api/images (spec §8) - caller's own tasks only, newest first, capped at 100.</summary>
    [HttpGet]
    [Authorize]
    [EnableRateLimiting("reads")]
    public async Task<IActionResult> List([FromQuery] string? operation, [FromQuery] string? state, CancellationToken ct)
    {
        var ownerId = User.FindFirst(ClaimTypes_NameIdentifier)?.Value;
        if (string.IsNullOrWhiteSpace(ownerId)) return Unauthorized();

        ImageOperation? parsedOperation = null;
        if (!string.IsNullOrWhiteSpace(operation))
        {
            if (!Enum.TryParse<ImageOperation>(operation, true, out var op))
                return Problem("operation must be 'Segment' or 'Regions'.", statusCode: StatusCodes.Status400BadRequest);
            parsedOperation = op;
        }

        ImageTaskState? parsedState = null;
        if (!string.IsNullOrWhiteSpace(state))
        {
            if (!Enum.TryParse<ImageTaskState>(state, true, out var st))
                return Problem("state is not a recognized task state.", statusCode: StatusCodes.Status400BadRequest);
            parsedState = st;
        }

        var items = await _service.ListAsync(ownerId, parsedOperation, parsedState, ct);
        return Ok(items.Select(t => new ImageSummaryResponse(
            t.RequestId, t.Operation.ToString(), t.Mode, t.State.ToString(), t.CreatedAtUtc, t.UpdatedAtUtc)));
    }

    /// <summary>DELETE /api/images/{id} (spec §8, NEW) - owner-scoped; deletes the row, its MaskGroups, and its storage objects.</summary>
    [HttpDelete("{id:guid}")]
    [Authorize]
    [EnableRateLimiting("writes")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var ownerId = User.FindFirst(ClaimTypes_NameIdentifier)?.Value;
        if (string.IsNullOrWhiteSpace(ownerId)) return Unauthorized();

        var deleted = await _service.DeleteAsync(id, ownerId, ct);
        return deleted ? NoContent() : NotFound();
    }

    // Local alias kept short - System.Security.Claims.ClaimTypes.NameIdentifier.
    private const string ClaimTypes_NameIdentifier = System.Security.Claims.ClaimTypes.NameIdentifier;
}
