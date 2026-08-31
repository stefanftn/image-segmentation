using Microsoft.AspNetCore.Identity;

namespace ImageSeg.Domain.Identity.Entities;

/// <summary>
/// Spec §2.3, §3. Extends the standard ASP.NET Core Identity user with no additional fields
/// unless a real requirement surfaces - Domain is allowed to reference
/// Microsoft.AspNetCore.Identity here because it is a zero-cost abstraction package (types
/// only, no ASP.NET Core hosting dependency), not a violation of Domain's "zero dependencies"
/// rule in the sense that matters: no Infrastructure- or Web-layer package leaks in.
/// </summary>
public class ApplicationUser : IdentityUser
{
}
