using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using ImageSeg.Domain.Identity.Entities;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace ImageSeg.Web.Identity;

/// <summary>Authentication:Jwt:*  - required for the app to start; see the check in JwtTokenService's constructor.</summary>
public sealed class JwtOptions
{
    public const string SectionName = "Authentication:Jwt";

    /// <summary>
    /// HMAC-SHA256 signing secret. Must be a real random value at least 32 characters long -
    /// there is no dev-mode fallback, because a guessable or empty signing key means anyone can
    /// mint their own valid access token for any user id.
    /// </summary>
    public string SigningKey { get; set; } = "";

    public string Issuer { get; set; } = "ImageSeg";
    public string Audience { get; set; } = "ImageSeg";

    /// <summary>Lifetime of a normal access token returned by login/register/2fa-verify.</summary>
    public int AccessTokenExpiryMinutes { get; set; } = 120;

    /// <summary>
    /// Lifetime of the short-lived, single-purpose token issued when a login requires a 2FA
    /// code (spec §3's TOTP flow). Deliberately short - this token is good for nothing except
    /// presenting back to POST /api/auth/2fa/verify within a couple of minutes of the original
    /// login attempt.
    /// </summary>
    public int TwoFactorTokenExpiryMinutes { get; set; } = 5;
}

/// <summary>
/// Issues and validates every JWT this system hands out. The frontend this backend serves
/// (a separately-hosted static app with no `credentials: "include"` on any of its fetch calls)
/// consumes the API as stateless bearer tokens, not cookies - spec §3 explicitly leaves that
/// choice to "how the frontend actually consumes this," and this is that decision made
/// concrete. ASP.NET Core Identity (UserManager/SignInManager/RoleManager) is still used for
/// everything password/2FA/external-login related; only the credential handed back to the
/// browser changed from a cookie to a signed token.
/// </summary>
public sealed class JwtTokenService
{
    private const string PurposeClaimType = "purpose";
    private const string AccessPurpose = "access";
    private const string TwoFactorChallengePurpose = "2fa_challenge";

    private readonly JwtOptions _options;
    private readonly SymmetricSecurityKey _signingKey;

    public JwtTokenService(IOptions<JwtOptions> options)
    {
        _options = options.Value;

        if (string.IsNullOrWhiteSpace(_options.SigningKey) || _options.SigningKey.Length < 32)
        {
            throw new InvalidOperationException(
                "Authentication:Jwt:SigningKey must be set to a random value at least 32 characters " +
                "long before the app can start. Generate one with e.g. " +
                "`openssl rand -base64 48` and set it via configuration/environment - never commit " +
                "a real value to source control.");
        }

        _signingKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.SigningKey));
    }

    /// <summary>A normal access token: everything the app-facing API's [Authorize] endpoints accept.</summary>
    public (string Token, DateTime ExpiresAtUtc) CreateAccessToken(ApplicationUser user)
    {
        var expiresAtUtc = DateTime.UtcNow.AddMinutes(_options.AccessTokenExpiryMinutes);
        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id),
            new Claim(ClaimTypes.Email, user.Email ?? ""),
            new Claim(PurposeClaimType, AccessPurpose)
        };
        return (BuildToken(claims, expiresAtUtc), expiresAtUtc);
    }

    /// <summary>
    /// A narrow, short-lived token identifying only "this user still needs to present a 2FA
    /// code" - carries no authorization for anything else. Returned to the client as
    /// `twoFactorToken` and presented back to POST /api/auth/2fa/verify.
    /// </summary>
    public string CreateTwoFactorChallengeToken(ApplicationUser user)
    {
        var expiresAtUtc = DateTime.UtcNow.AddMinutes(_options.TwoFactorTokenExpiryMinutes);
        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id),
            new Claim(PurposeClaimType, TwoFactorChallengePurpose)
        };
        return BuildToken(claims, expiresAtUtc);
    }

    /// <summary>Returns the user id encoded in a valid, unexpired two-factor challenge token, or null.</summary>
    public string? ValidateTwoFactorChallengeToken(string token)
    {
        var principal = ValidateToken(token);
        if (principal is null) return null;

        var purpose = principal.FindFirstValue(PurposeClaimType);
        if (purpose != TwoFactorChallengePurpose) return null;

        return principal.FindFirstValue(ClaimTypes.NameIdentifier);
    }

    private ClaimsPrincipal? ValidateToken(string token)
    {
        var handler = new JwtSecurityTokenHandler();
        var parameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = _options.Issuer,
            ValidateAudience = true,
            ValidAudience = _options.Audience,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = _signingKey,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromSeconds(30)
        };

        try
        {
            return handler.ValidateToken(token, parameters, out _);
        }
        catch (Exception)
        {
            // Deliberately broad, not just SecurityTokenException: a garbage input string can
            // throw SecurityTokenMalformedException, ArgumentException, or other failure modes
            // depending on exactly how it fails to look like a JWT, and the caller's contract
            // here is simply "is this a valid, currently-usable token or not" - every failure
            // mode means no, there's no case where a narrower catch would let a legitimately
            // valid token through that this one doesn't also let through.
            return null;
        }
    }

    private string BuildToken(IEnumerable<Claim> claims, DateTime expiresAtUtc)
    {
        var credentials = new SigningCredentials(_signingKey, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(_options.Issuer, _options.Audience, claims, expires: expiresAtUtc, signingCredentials: credentials);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    /// <summary>Exposed so Program.cs's AddJwtBearer validation parameters match exactly what this service signs with.</summary>
    public TokenValidationParameters BuildBearerValidationParameters() => new()
    {
        ValidateIssuer = true,
        ValidIssuer = _options.Issuer,
        ValidateAudience = true,
        ValidAudience = _options.Audience,
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = _signingKey,
        ValidateLifetime = true,
        ClockSkew = TimeSpan.FromSeconds(30)
    };
}
