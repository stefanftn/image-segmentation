using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using ImageSeg.Web.Identity;
using Xunit;

namespace ImageSeg.Tests.Auth;

public sealed class RegisterTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private readonly TestWebApplicationFactory _factory;
    private HttpClient _client = default!;

    public RegisterTests(TestWebApplicationFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        await _factory.InitializeDatabaseAsync();
        _client = _factory.CreateClient();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private static string NewEmail() => $"{Guid.NewGuid():N}@example.com";

    // ---- happy path ------------------------------------------------------------------

    [Fact]
    public async Task Register_WithValidCredentials_ReturnsAccessToken()
    {
        var response = await _client.PostAsJsonAsync("/api/auth/register",
            new RegisterRequest(NewEmail(), "Str0ng!Pass"));

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadFromJsonAsync<AuthTokenResponse>();
        body.Should().NotBeNull();
        body!.Token.Should().NotBeNullOrWhiteSpace();
        body.ExpiresAtUtc.Should().BeAfter(DateTime.UtcNow, "a freshly issued token should not already be expired");
    }

    [Fact]
    public async Task Register_ThenCallProtectedEndpoint_WithTheReturnedToken_Succeeds()
    {
        // Registration's whole point is producing a usable credential, not just a 200 - this
        // confirms the token it returns actually works, end to end, not just that the shape
        // of the response looks right.
        var response = await _client.PostAsJsonAsync("/api/auth/register",
            new RegisterRequest(NewEmail(), "Str0ng!Pass"));
        var token = (await response.Content.ReadFromJsonAsync<AuthTokenResponse>())!.Token;

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/images");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        var protectedResponse = await _client.SendAsync(request);

        protectedResponse.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ---- failure cases -----------------------------------------------------------------

    [Fact]
    public async Task Register_WithAlreadyRegisteredEmail_ReturnsBadRequest()
    {
        var email = NewEmail();
        await _client.PostAsJsonAsync("/api/auth/register", new RegisterRequest(email, "Str0ng!Pass"));

        var response = await _client.PostAsJsonAsync("/api/auth/register",
            new RegisterRequest(email, "AnotherStr0ng!Pass"));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Theory]
    // Program.cs only overrides Password.RequiredLength (8) - every other Identity password
    // default stays active (RequireUppercase, RequireLowercase, RequireDigit,
    // RequireNonAlphanumeric all true), so each case below violates exactly one active rule.
    [InlineData("Ab1!",             "too short (Password.RequiredLength = 8)")]
    [InlineData("str0ng!password",  "no uppercase letter")]
    [InlineData("STR0NG!PASSWORD",  "no lowercase letter")]
    [InlineData("Strong!Password",  "no digit")]
    [InlineData("Str0ngPassword",   "no non-alphanumeric character")]
    public async Task Register_WithPasswordViolatingAnIdentityRule_ReturnsBadRequest(string weakPassword, string _)
    {
        var response = await _client.PostAsJsonAsync("/api/auth/register",
            new RegisterRequest(NewEmail(), weakPassword));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
