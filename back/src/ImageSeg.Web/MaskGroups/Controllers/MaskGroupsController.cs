using ImageSeg.Application.MaskGroups.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace ImageSeg.Web.MaskGroups.Controllers;

public sealed record CreateMaskGroupRequest(string Name, List<int> RegionIds);
public sealed record UpdateMaskGroupRequest(string Name, List<int> RegionIds);

public sealed record MaskGroupResponse(Guid Id, Guid ImageTaskId, string Name, List<int> RegionIds, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

/// <summary>
/// Spec §8. CRUD for saved region-id selections on a Regions task. Every route is owner-scoped
/// and returns 404 (not 403) on mismatch, so a non-owner cannot learn the task exists.
/// </summary>
[ApiController]
[Route("api/images/{imageId:guid}/groups")]
[Authorize]
public sealed class MaskGroupsController : ControllerBase
{
    private readonly IMaskGroupService _service;

    public MaskGroupsController(IMaskGroupService service) => _service = service;

    [HttpPost]
    [EnableRateLimiting("writes")]
    public async Task<IActionResult> Create(Guid imageId, [FromBody] CreateMaskGroupRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Name))
            return Problem("name is required.", statusCode: StatusCodes.Status400BadRequest);

        var ownerId = OwnerId();
        if (ownerId is null) return Unauthorized();

        try
        {
            var dto = await _service.CreateAsync(imageId, ownerId, body.Name, body.RegionIds ?? new List<int>(), ct);
            return CreatedAtAction(nameof(List), new { imageId }, ToResponse(dto));
        }
        catch (KeyNotFoundException)
        {
            return NotFound();
        }
        catch (InvalidOperationException ex)
        {
            return Problem(ex.Message, statusCode: StatusCodes.Status400BadRequest);
        }
    }

    [HttpPut("{groupId:guid}")]
    [EnableRateLimiting("writes")]
    public async Task<IActionResult> Update(Guid imageId, Guid groupId, [FromBody] UpdateMaskGroupRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Name))
            return Problem("name is required.", statusCode: StatusCodes.Status400BadRequest);

        var ownerId = OwnerId();
        if (ownerId is null) return Unauthorized();

        var dto = await _service.UpdateAsync(imageId, groupId, ownerId, body.Name, body.RegionIds ?? new List<int>(), ct);
        return dto is null ? NotFound() : Ok(ToResponse(dto));
    }

    [HttpDelete("{groupId:guid}")]
    [EnableRateLimiting("writes")]
    public async Task<IActionResult> Delete(Guid imageId, Guid groupId, CancellationToken ct)
    {
        var ownerId = OwnerId();
        if (ownerId is null) return Unauthorized();

        var deleted = await _service.DeleteAsync(imageId, groupId, ownerId, ct);
        return deleted ? NoContent() : NotFound();
    }

    /// <summary>GET /api/images/{id}/groups - the whole saved "workspace" for a task, loaded at once.</summary>
    [HttpGet]
    [EnableRateLimiting("reads")]
    public async Task<IActionResult> List(Guid imageId, CancellationToken ct)
    {
        var ownerId = OwnerId();
        if (ownerId is null) return Unauthorized();

        var groups = await _service.ListAsync(imageId, ownerId, ct);
        if (groups is null) return NotFound();

        return Ok(groups.Select(ToResponse));
    }

    private string? OwnerId() => User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;

    private static MaskGroupResponse ToResponse(MaskGroupDto g) =>
        new(g.Id, g.ImageTaskId, g.Name, g.RegionIds.ToList(), g.CreatedAtUtc, g.UpdatedAtUtc);
}
