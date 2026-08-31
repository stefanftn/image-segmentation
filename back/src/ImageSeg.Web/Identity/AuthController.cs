using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Google;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ImageSeg.Domain.Identity.Entities;

namespace ImageSeg.Web.Identity;

public sealed record RegisterRequest(string Email, string Password);
public sealed record LoginRequest(string Email, string Password);
public sealed record TwoFactorLoginRequest(string TwoFactorToken, string Code);
public sealed record AuthTokenResponse(string Token, DateTime ExpiresAtUtc);
public sealed record TwoFactorChallengeResponse(bool RequiresTwoFactor, string TwoFactorToken);

public sealed record TwoFactorSetupResponse(string SharedKey, string AuthenticatorUri);
public sealed record TwoFactorEnableRequest(string Code);
public sealed record RecoveryCodesResponse(IEnumerable<string> RecoveryCodes);

/// <summary>
/// Spec §3. Real auth from day one - there is no dev-token endpoint anywhere in this system.
///
/// Every app-facing response here is a token, not a cookie: this API is consumed by a
/// separately-hosted static frontend whose fetch calls never set `credentials: "include"`, so a
/// cookie could never actually reach it cross-origin even if one were issued. See
/// JwtTokenService for why - ASP.NET Core Identity (UserManager/SignInManager) still does all
/// the password/lockout/2FA/external-login bookkeeping underneath; only the credential handed
/// back to the browser is different from the framework default.
/// </summary>
[ApiController]
[Route("api/auth")]
[EnableRateLimiting("writes")]
public sealed class AuthController : ControllerBase
{
    private readonly SignInManager<ApplicationUser> _signInManager;
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly JwtTokenService _jwt;
    private readonly IConfiguration _configuration;

    public AuthController(SignInManager<ApplicationUser> signInManager, UserManager<ApplicationUser> userManager, JwtTokenService jwt, IConfiguration configuration)
    {
        _signInManager = signInManager;
        _userManager = userManager;
        _jwt = jwt;
        _configuration = configuration;
    }

    [HttpPost("register")]
    [AllowAnonymous]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request)
    {
        var user = new ApplicationUser { UserName = request.Email, Email = request.Email };
        var result = await _userManager.CreateAsync(user, request.Password);
        if (!result.Succeeded)
            return Problem(string.Join(" ", result.Errors.Select(e => e.Description)), statusCode: StatusCodes.Status400BadRequest);

        // A brand-new user never has 2FA enabled yet, so registration always completes with a
        // real token - no two-factor branch to consider here the way login has one.
        var (token, expiresAtUtc) = _jwt.CreateAccessToken(user);
        return Ok(new AuthTokenResponse(token, expiresAtUtc));
    }

    [HttpPost("login")]
    [AllowAnonymous]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        var user = await _userManager.FindByEmailAsync(request.Email);
        if (user is null)
            return Problem("Invalid credentials.", statusCode: StatusCodes.Status401Unauthorized);

        // PasswordSignInAsync, not CheckPasswordSignInAsync: the latter looks like the right
        // building block ("verify password without establishing a session") but its whole
        // purpose is checking ONLY the password - it passes bypassTwoFactor: true internally,
        // so result.RequiresTwoFactor is always false through that path regardless of whether
        // the user actually has 2FA enabled. PasswordSignInAsync respects 2FA correctly
        // (bypassTwoFactor: false). Its side effect - writing a Set-Cookie header when 2FA is
        // NOT required and the password matches - is harmless here: this app is JWT-bearer end
        // to end (see JwtTokenService), so no client of this API ever reads or sends that
        // cookie back; the real credential is the token returned below.
        var result = await _signInManager.PasswordSignInAsync(user, request.Password, isPersistent: false, lockoutOnFailure: true);

        if (result.RequiresTwoFactor)
        {
            var twoFactorToken = _jwt.CreateTwoFactorChallengeToken(user);
            return Ok(new TwoFactorChallengeResponse(true, twoFactorToken));
        }

        if (result.IsLockedOut)
            return Problem("Account is locked out.", statusCode: StatusCodes.Status401Unauthorized);

        if (!result.Succeeded)
            return Problem("Invalid credentials.", statusCode: StatusCodes.Status401Unauthorized);

        var (token, expiresAtUtc) = _jwt.CreateAccessToken(user);
        return Ok(new AuthTokenResponse(token, expiresAtUtc));
    }

    /// <summary>
    /// Completes a login that returned RequiresTwoFactor. Takes the short-lived challenge token
    /// from that response plus a 6-digit TOTP code, and returns a real access token.
    /// </summary>
    [HttpPost("2fa/verify")]
    [AllowAnonymous]
    public async Task<IActionResult> VerifyTwoFactorLogin([FromBody] TwoFactorLoginRequest request)
    {
        var userId = _jwt.ValidateTwoFactorChallengeToken(request.TwoFactorToken);
        if (userId is null)
            return Problem("That code has expired - please sign in again.", statusCode: StatusCodes.Status401Unauthorized);

        var user = await _userManager.FindByIdAsync(userId);
        if (user is null)
            return Problem("That code has expired - please sign in again.", statusCode: StatusCodes.Status401Unauthorized);

        var isValid = await _userManager.VerifyTwoFactorTokenAsync(
            user, _userManager.Options.Tokens.AuthenticatorTokenProvider, request.Code);

        if (!isValid)
            return Problem("Invalid authenticator code.", statusCode: StatusCodes.Status401Unauthorized);

        var (token, expiresAtUtc) = _jwt.CreateAccessToken(user);
        return Ok(new AuthTokenResponse(token, expiresAtUtc));
    }

    /// <summary>Starts TOTP 2FA setup for the caller's own account: returns the shared key and an otpauth:// URI for a QR code.</summary>
    [HttpPost("2fa/setup")]
    [Authorize]
    public async Task<IActionResult> SetupTwoFactor()
    {
        var user = await _userManager.GetUserAsync(User);
        if (user is null) return Unauthorized();

        await _userManager.ResetAuthenticatorKeyAsync(user);
        var unformattedKey = await _userManager.GetAuthenticatorKeyAsync(user);

        var uri = GenerateAuthenticatorUri(user.Email ?? user.UserName ?? user.Id, unformattedKey!);
        return Ok(new TwoFactorSetupResponse(unformattedKey!, uri));
    }

    /// <summary>Confirms the first TOTP code and turns 2FA on for the caller's own account (distinct from the login-completion /2fa/verify above).</summary>
    [HttpPost("2fa/enable")]
    [Authorize]
    public async Task<IActionResult> EnableTwoFactor([FromBody] TwoFactorEnableRequest request)
    {
        var user = await _userManager.GetUserAsync(User);
        if (user is null) return Unauthorized();

        var isValid = await _userManager.VerifyTwoFactorTokenAsync(
            user, _userManager.Options.Tokens.AuthenticatorTokenProvider, request.Code);

        if (!isValid)
            return Problem("Invalid authenticator code.", statusCode: StatusCodes.Status400BadRequest);

        await _userManager.SetTwoFactorEnabledAsync(user, true);
        var codes = await _userManager.GenerateNewTwoFactorRecoveryCodesAsync(user, 10);

        return Ok(new RecoveryCodesResponse(codes ?? Enumerable.Empty<string>()));
    }

    [HttpPost("2fa/disable")]
    [Authorize]
    public async Task<IActionResult> DisableTwoFactor()
    {
        var user = await _userManager.GetUserAsync(User);
        if (user is null) return Unauthorized();

        await _userManager.SetTwoFactorEnabledAsync(user, false);
        return NoContent();
    }

    /// <summary>Standard ASP.NET Core Identity external-login challenge (spec §3).</summary>
    [HttpGet("google/login")]
    [AllowAnonymous]
    public IActionResult ExternalLoginGoogle([FromQuery] string returnUrl = "/")
    {
        // Google's scheme is only registered at all when real credentials are configured
        // (Program.cs) - calling Challenge() for a scheme that was never registered throws an
        // unhandled InvalidOperationException (a bare 500), so this has to be checked
        // explicitly here rather than assumed. The same Authentication:Google:ClientId/
        // ClientSecret check Program.cs uses to decide whether to call .AddGoogle(...) at all.
        if (!IsGoogleConfigured())
        {
            return Problem(
                "Google sign-in is not configured on this server.",
                statusCode: StatusCodes.Status404NotFound);
        }

        var redirectUrl = Url.Action(nameof(ExternalLoginCallback), values: new { returnUrl });
        var properties = _signInManager.ConfigureExternalAuthenticationProperties(GoogleDefaults.AuthenticationScheme, redirectUrl);
        return Challenge(properties, GoogleDefaults.AuthenticationScheme);
    }

    /// <summary>
    /// Internal only - the frontend never constructs this URL itself, only receives the final
    /// redirect to its own returnUrl. Delivers the credential as a query parameter
    /// (?access_token= or ?two_factor_token=) since there is no other channel to hand a token
    /// to client-side JS at the end of a server-driven OAuth redirect chain.
    ///
    /// NOT the URI Google redirects to - that's the OAuth handler's own CallbackPath
    /// ("/api/auth/signin-google", set in Program.cs's AddGoogle call), intercepted directly
    /// by the handler before this action ever runs (register that path in Google Cloud
    /// Console, not this one). This action only runs afterward, once
    /// ConfigureExternalAuthenticationProperties's redirectUrl (set below) is followed
    /// internally by the framework.
    /// </summary>
    [HttpGet("external-login-callback")]
    [AllowAnonymous]
    public async Task<IActionResult> ExternalLoginCallback([FromQuery] string returnUrl = "/")
    {
        var info = await _signInManager.GetExternalLoginInfoAsync();
        if (info is null) return Redirect(AppendQuery(returnUrl, "error", "external_login_failed"));

        var user = await _userManager.FindByLoginAsync(info.LoginProvider, info.ProviderKey);
        if (user is null)
        {
            var email = info.Principal.FindFirstValue(ClaimTypes.Email);
            if (string.IsNullOrWhiteSpace(email))
                return Redirect(AppendQuery(returnUrl, "error", "no_email_from_provider"));

            user = await _userManager.FindByEmailAsync(email);
            if (user is null)
            {
                user = new ApplicationUser { UserName = email, Email = email };
                var createResult = await _userManager.CreateAsync(user);
                if (!createResult.Succeeded)
                    return Redirect(AppendQuery(returnUrl, "error", "account_creation_failed"));
            }

            await _userManager.AddLoginAsync(user, info);
        }

        if (await _userManager.GetTwoFactorEnabledAsync(user))
        {
            var twoFactorToken = _jwt.CreateTwoFactorChallengeToken(user);
            return Redirect(AppendQuery(returnUrl, "two_factor_token", twoFactorToken));
        }

        var (accessToken, _) = _jwt.CreateAccessToken(user);
        return Redirect(AppendQuery(returnUrl, "access_token", accessToken));
    }

    private static string AppendQuery(string url, string key, string value)
    {
        var separator = url.Contains('?') ? "&" : "?";
        return $"{url}{separator}{key}={Uri.EscapeDataString(value)}";
    }

    private bool IsGoogleConfigured()
        => !string.IsNullOrWhiteSpace(_configuration["Authentication:Google:ClientId"])
           && !string.IsNullOrWhiteSpace(_configuration["Authentication:Google:ClientSecret"]);

    private static string GenerateAuthenticatorUri(string email, string unformattedKey)
    {
        const string issuer = "ImageSeg";
        return string.Format(
            "otpauth://totp/{0}:{1}?secret={2}&issuer={0}&digits=6",
            UrlEncoder.Default.Encode(issuer),
            UrlEncoder.Default.Encode(email),
            unformattedKey);
    }
}
