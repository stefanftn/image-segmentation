using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using ImageSeg.Web.Identity;
using Xunit;

namespace ImageSeg.Tests.Auth;

public sealed class TwoFactorTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private const string Password = "Str0ng!Pass";

    private readonly TestWebApplicationFactory _factory;
    private HttpClient _client = default!;

    public TwoFactorTests(TestWebApplicationFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        await _factory.InitializeDatabaseAsync();
        _client = _factory.CreateClient();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private static string NewEmail() => $"{Guid.NewGuid():N}@example.com";

    private async Task<(string Email, string AccessToken)> RegisterAsync()
    {
        var email = NewEmail();
        var response = await _client.PostAsJsonAsync("/api/auth/register", new RegisterRequest(email, Password));
        var token = (await response.Content.ReadFromJsonAsync<AuthTokenResponse>())!.Token;
        return (email, token);
    }

    private HttpRequestMessage Authorized(HttpMethod method, string path, string accessToken, object? body = null)
    {
        var request = new HttpRequestMessage(method, path)
        {
            Headers = { Authorization = new AuthenticationHeaderValue("Bearer", accessToken) }
        };
        if (body is not null) request.Content = JsonContent.Create(body);
        return request;
    }

    /// <summary>Full setup -&gt; enable flow, returning the shared key so a caller can keep generating valid codes.</summary>
    private async Task<string> EnableTwoFactorAsync(string accessToken)
    {
        var setupResponse = await _client.SendAsync(Authorized(HttpMethod.Post, "/api/auth/2fa/setup", accessToken));
        setupResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var setup = (await setupResponse.Content.ReadFromJsonAsync<TwoFactorSetupResponse>())!;

        var enableResponse = await _client.SendAsync(Authorized(
            HttpMethod.Post, "/api/auth/2fa/enable", accessToken, new TwoFactorEnableRequest(Totp.GenerateCode(setup.SharedKey))));
        enableResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        return setup.SharedKey;
    }

    // ---- setup / enable — happy path ---------------------------------------------------

    [Fact]
    public async Task EnableTwoFactor_WithAValidCode_ReturnsTenRecoveryCodes()
    {
        var (_, token) = await RegisterAsync();

        var setupResponse = await _client.SendAsync(Authorized(HttpMethod.Post, "/api/auth/2fa/setup", token));
        var setup = (await setupResponse.Content.ReadFromJsonAsync<TwoFactorSetupResponse>())!;

        var response = await _client.SendAsync(Authorized(
            HttpMethod.Post, "/api/auth/2fa/enable", token, new TwoFactorEnableRequest(Totp.GenerateCode(setup.SharedKey))));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadFromJsonAsync<RecoveryCodesResponse>();
        body!.RecoveryCodes.Should().HaveCount(10);
    }

    // ---- setup / enable — failure cases -------------------------------------------------

    [Fact]
    public async Task SetupTwoFactor_WithoutAuthentication_ReturnsUnauthorized()
    {
        var response = await _client.PostAsync("/api/auth/2fa/setup", null);
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task EnableTwoFactor_WithWrongCode_ReturnsBadRequest()
    {
        var (_, token) = await RegisterAsync();
        await _client.SendAsync(Authorized(HttpMethod.Post, "/api/auth/2fa/setup", token));

        var response = await _client.SendAsync(Authorized(
            HttpMethod.Post, "/api/auth/2fa/enable", token, new TwoFactorEnableRequest("000000")));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- login completion — happy path ---------------------------------------------------

    [Fact]
    public async Task Login_WhenTwoFactorIsEnabled_ReturnsChallengeInsteadOfAToken()
    {
        var (email, token) = await RegisterAsync();
        await EnableTwoFactorAsync(token);

        var response = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(email, Password));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadFromJsonAsync<TwoFactorChallengeResponse>();
        body!.RequiresTwoFactor.Should().BeTrue();
        body.TwoFactorToken.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task VerifyTwoFactorLogin_WithAValidCode_ReturnsAnAccessToken()
    {
        var (email, token) = await RegisterAsync();
        var sharedKey = await EnableTwoFactorAsync(token);

        var loginResponse = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(email, Password));
        var challenge = (await loginResponse.Content.ReadFromJsonAsync<TwoFactorChallengeResponse>())!;

        var response = await _client.PostAsJsonAsync("/api/auth/2fa/verify",
            new TwoFactorLoginRequest(challenge.TwoFactorToken, Totp.GenerateCode(sharedKey)));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadFromJsonAsync<AuthTokenResponse>();
        body!.Token.Should().NotBeNullOrWhiteSpace();
    }

    // ---- login completion — failure cases -------------------------------------------------

    [Fact]
    public async Task VerifyTwoFactorLogin_WithWrongCode_ReturnsUnauthorized()
    {
        var (email, token) = await RegisterAsync();
        await EnableTwoFactorAsync(token);

        var loginResponse = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(email, Password));
        var challenge = (await loginResponse.Content.ReadFromJsonAsync<TwoFactorChallengeResponse>())!;

        var response = await _client.PostAsJsonAsync("/api/auth/2fa/verify",
            new TwoFactorLoginRequest(challenge.TwoFactorToken, "000000"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task VerifyTwoFactorLogin_WithGarbageToken_ReturnsUnauthorized()
    {
        var response = await _client.PostAsJsonAsync("/api/auth/2fa/verify",
            new TwoFactorLoginRequest("not-a-real-jwt", "123456"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task VerifyTwoFactorLogin_WithANormalAccessTokenInsteadOfAChallengeToken_ReturnsUnauthorized()
    {
        // A normal access token IS a validly-signed JWT for the same user, so this checks the
        // "purpose" claim guard in JwtTokenService.ValidateTwoFactorChallengeToken specifically
        // - not just "is the JWT signature valid". Without that guard, anyone who already has
        // an access token could feed it in here and it would validate as a signature match,
        // even though it was never issued as a 2FA challenge.
        var (_, accessToken) = await RegisterAsync();

        var response = await _client.PostAsJsonAsync("/api/auth/2fa/verify",
            new TwoFactorLoginRequest(accessToken, "123456"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
