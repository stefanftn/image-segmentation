using System.Globalization;
using System.Security.Cryptography;

namespace ImageSeg.Tests;

/// <summary>
/// Standard RFC 6238 (TOTP) / RFC 4226 (HOTP) code generation - SHA1, 30-second time step,
/// 6 digits - matching exactly what ASP.NET Core Identity's built-in authenticator token
/// provider computes internally (UserManager.Options.Tokens.AuthenticatorTokenProvider).
/// Exists so tests can "type in" a real, currently-valid code the same way a person reading
/// their authenticator app would, instead of mocking around VerifyTwoFactorTokenAsync.
/// </summary>
internal static class Totp
{
    private const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static string GenerateCode(string base32Secret, DateTime? atUtc = null)
    {
        var key = Base32Decode(base32Secret);
        var timestep = (long)((atUtc ?? DateTime.UtcNow) - DateTime.UnixEpoch).TotalSeconds / 30;

        var counter = new byte[8];
        for (var i = 7; i >= 0; i--)
        {
            counter[i] = (byte)(timestep & 0xff);
            timestep >>= 8;
        }

        var hash = HMACSHA1.HashData(key, counter);

        // Standard RFC 4226 dynamic truncation.
        var offset = hash[^1] & 0x0f;
        var binaryCode = ((hash[offset] & 0x7f) << 24)
                        | ((hash[offset + 1] & 0xff) << 16)
                        | ((hash[offset + 2] & 0xff) << 8)
                        | (hash[offset + 3] & 0xff);

        var code = binaryCode % 1_000_000;
        return code.ToString("D6", CultureInfo.InvariantCulture);
    }

    private static byte[] Base32Decode(string input)
    {
        input = input.TrimEnd('=').ToUpperInvariant();

        var bits = 0;
        var value = 0;
        var output = new List<byte>(input.Length * 5 / 8);

        foreach (var c in input)
        {
            var index = Base32Alphabet.IndexOf(c);
            if (index < 0) continue; // tolerate stray formatting characters (spaces, dashes)

            value = (value << 5) | index;
            bits += 5;

            if (bits >= 8)
            {
                output.Add((byte)((value >> (bits - 8)) & 0xff));
                bits -= 8;
            }
        }

        return output.ToArray();
    }
}
