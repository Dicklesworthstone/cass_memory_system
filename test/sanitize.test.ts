import { describe, expect, it } from "bun:test";
import { sanitize, compileExtraPatterns, SECRET_PATTERNS } from "../src/sanitize.js";

// =============================================================================
// SECRET_PATTERNS
// =============================================================================
describe("SECRET_PATTERNS", () => {
  it("is an array", () => {
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
  });

  it("contains pattern/replacement pairs", () => {
    for (const entry of SECRET_PATTERNS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.replacement).toBe("string");
    }
  });

  it("has at least 5 patterns", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
});

// =============================================================================
// sanitize
// =============================================================================
describe("sanitize", () => {
  const enabledConfig = { enabled: true };
  const disabledConfig = { enabled: false };

  describe("basic behavior", () => {
    it("returns original text when disabled", () => {
      const text = "AKIA1234567890123456 secret";
      const result = sanitize(text, disabledConfig);
      expect(result).toBe(text);
    });

    it("sanitizes text when enabled", () => {
      const text = "My key is AKIA1234567890123456";
      const result = sanitize(text, enabledConfig);
      expect(result).not.toContain("AKIA1234567890123456");
      expect(result).toContain("[AWS_ACCESS_KEY]");
    });

    it("returns empty string unchanged", () => {
      expect(sanitize("", enabledConfig)).toBe("");
    });

    it("returns text without secrets unchanged", () => {
      const text = "This is a normal message without secrets.";
      expect(sanitize(text, enabledConfig)).toBe(text);
    });
  });

  describe("AWS credentials", () => {
    it("redacts AWS access key ID", () => {
      const text = "Access key: AKIA1234567890ABCDEF";
      const result = sanitize(text, enabledConfig);
      expect(result).toBe("Access key: [AWS_ACCESS_KEY]");
    });

    it("redacts AWS secret key", () => {
      const text = "Secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[AWS_SECRET_KEY]");
    });

    it("redacts multiple AWS keys", () => {
      const text = "Key1: AKIA1111111111111111, Key2: AKIA2222222222222222";
      const result = sanitize(text, enabledConfig);
      expect(result).not.toContain("AKIA1111111111111111");
      expect(result).not.toContain("AKIA2222222222222222");
    });
  });

  describe("Bearer tokens", () => {
    it("redacts Bearer token", () => {
      const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[BEARER_TOKEN]");
      expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("redacts Bearer token with padding", () => {
      const text = "Authorization: Bearer abc123def456ghi789+/=";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[BEARER_TOKEN]");
    });
  });

  describe("API keys and tokens", () => {
    it("redacts api_key format", () => {
      const text = 'api_key="sk_test_1234567890abcdefghij"';
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[API_KEY]");
    });

    it("redacts api-key format", () => {
      const text = "api-key: abcdefghijklmnopqrstuvwxyz";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[API_KEY]");
    });

    it("redacts token format", () => {
      const text = 'token: "abcdefghijklmnopqrstuvwxyz"';
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[TOKEN]");
    });
  });

  describe("private keys", () => {
    it("redacts RSA private key", () => {
      const text = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyf8n
-----END RSA PRIVATE KEY-----`;
      const result = sanitize(text, enabledConfig);
      expect(result).toBe("[PRIVATE_KEY]");
    });

    it("redacts generic private key", () => {
      const text = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSk
-----END PRIVATE KEY-----`;
      const result = sanitize(text, enabledConfig);
      expect(result).toBe("[PRIVATE_KEY]");
    });

    it("redacts EC private key", () => {
      const text = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIBJn
-----END EC PRIVATE KEY-----`;
      const result = sanitize(text, enabledConfig);
      expect(result).toBe("[PRIVATE_KEY]");
    });

    it("redacts OPENSSH private key", () => {
      const text = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA
-----END OPENSSH PRIVATE KEY-----`;
      const result = sanitize(text, enabledConfig);
      expect(result).toBe("[PRIVATE_KEY]");
    });
  });

  describe("GitHub tokens", () => {
    it("redacts GitHub personal access token (ghp_)", () => {
      // ghp_ requires exactly 36 alphanumeric chars
      const text = "GitHub PAT ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[GITHUB_PAT]");
      expect(result).not.toContain("ghp_ABCDEF");
    });

    it("redacts fine-grained GitHub PAT (github_pat_)", () => {
      // github_pat_ requires 22+ alphanumeric chars (including underscores)
      const text = "github_pat_11ABCDEFGHIJKLMNOP_1234567890";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[GITHUB_PAT]");
    });
  });

  describe("Slack tokens", () => {
    // Build token patterns dynamically to avoid triggering GitHub secret scanners
    const slackPrefix = (t: string) => `xox${t}`;

    it("redacts bot token pattern", () => {
      const text = `Slack bot: ${slackPrefix("b")}-1234567890-abc`;
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[SLACK_TOKEN]");
    });

    it("redacts user token pattern", () => {
      const text = `User: ${slackPrefix("p")}-9876543210`;
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[SLACK_TOKEN]");
    });

    it("redacts session token pattern", () => {
      const text = `Session: ${slackPrefix("s")}-abcdef123`;
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[SLACK_TOKEN]");
    });

    it("redacts app token pattern", () => {
      const text = `App: ${slackPrefix("a")}-xyz789`;
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[SLACK_TOKEN]");
    });

    it("redacts refresh token pattern", () => {
      const text = `Refresh: ${slackPrefix("r")}-refresh123`;
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[SLACK_TOKEN]");
    });
  });

  describe("database URLs", () => {
    it("redacts PostgreSQL URL credentials", () => {
      const text = "DATABASE_URL=postgres://user:supersecret@localhost:5432/db";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[USER]:[PASS]@");
      expect(result).not.toContain("supersecret");
    });

    it("redacts MySQL URL credentials", () => {
      const text = "mysql://admin:password123@db.example.com/mydb";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[USER]:[PASS]@");
      expect(result).not.toContain("password123");
    });

    it("redacts MongoDB URL credentials", () => {
      const text = "mongodb://root:secret@localhost:27017/test";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[USER]:[PASS]@");
      expect(result).not.toContain("secret");
    });

    it("redacts Redis URL credentials", () => {
      const text = "redis://default:mypassword@cache.example.com:6379";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[USER]:[PASS]@");
    });
  });

  describe("password patterns", () => {
    it("redacts password in quotes", () => {
      const text = 'password: "mysecretpassword"';
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[CREDENTIAL_REDACTED]");
      expect(result).not.toContain("mysecretpassword");
    });

    it("redacts password with single quotes", () => {
      const text = "password='verysecret12'";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[CREDENTIAL_REDACTED]");
    });
  });

  describe("extra patterns", () => {
    it("applies extra patterns when provided", () => {
      const text = "Custom secret: ABC-123-XYZ";
    const config = {
      enabled: true,
      extraPatterns: [/ABC-\d+-XYZ/g],
    };
    const result = sanitize(text, config);
    expect(result).toContain("[REDACTED_CUSTOM]");
    expect(result).not.toContain("ABC-123-XYZ");
  });

    it("handles multiple extra patterns", () => {
      const text = "First: SECRET1 Second: SECRET2";
      const config = {
        enabled: true,
        extraPatterns: [/SECRET1/g, /SECRET2/g],
      };
      const result = sanitize(text, config);
      expect(result).not.toContain("SECRET1");
      expect(result).not.toContain("SECRET2");
    });
  });

  describe("audit logging", () => {
    it("accepts auditLog option without throwing", () => {
      const text = "AKIA1234567890123456";
      const config = { enabled: true, auditLog: true };
      expect(() => sanitize(text, config)).not.toThrow();
    });

    it("accepts auditLevel debug without throwing", () => {
      const text = "AKIA1234567890123456";
      const config = { enabled: true, auditLog: true, auditLevel: "debug" as const };
      expect(() => sanitize(text, config)).not.toThrow();
    });
  });

  describe("edge cases", () => {
    it("handles text with multiple secret types", () => {
      // Use obviously fake patterns
      const text = `
        AWS: AKIA1234567890ABCDEF
        GitHub PAT ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234
        DB: postgres://user:pass@localhost/db
      `;
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("[AWS_ACCESS_KEY]");
      expect(result).toContain("[GITHUB_PAT]");
      expect(result).toContain("[USER]:[PASS]@");
    });

    it("preserves non-secret text around secrets", () => {
      const text = "Before AKIA1234567890123456 After";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("Before");
      expect(result).toContain("After");
      expect(result).toContain("[AWS_ACCESS_KEY]");
    });

    it("handles unicode text", () => {
      const text = "Secret 密码: AKIA1234567890123456 🔐";
      const result = sanitize(text, enabledConfig);
      expect(result).toContain("密码");
      expect(result).toContain("🔐");
      expect(result).toContain("[AWS_ACCESS_KEY]");
    });
  });
});

// =============================================================================
// compileExtraPatterns
// =============================================================================
describe("compileExtraPatterns", () => {
  it("returns empty array for undefined input", () => {
    const result = compileExtraPatterns(undefined);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty array input", () => {
    const result = compileExtraPatterns([]);
    expect(result).toEqual([]);
  });

  it("compiles string patterns to RegExp", () => {
    const result = compileExtraPatterns(["test"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(RegExp);
    expect(result[0].test("test")).toBe(true);
  });

  it("passes through RegExp patterns", () => {
    const pattern = /custom-pattern/gi;
    const result = compileExtraPatterns([pattern]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(pattern);
  });

  it("handles mixed string and RegExp patterns", () => {
    const result = compileExtraPatterns(["string-pattern", /regex-pattern/gi]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(RegExp);
    expect(result[1]).toBeInstanceOf(RegExp);
  });

  it("adds global and case-insensitive flags to string patterns", () => {
    const result = compileExtraPatterns(["test"]);
    expect(result[0].flags).toContain("g");
    expect(result[0].flags).toContain("i");
  });

  it("skips invalid regex patterns", () => {
    const result = compileExtraPatterns(["valid", "[[invalid", "also-valid"]);
    expect(result).toHaveLength(2);
  });

  it("skips excessively long patterns (>256 chars)", () => {
    const longPattern = "a".repeat(300);
    const result = compileExtraPatterns([longPattern, "short"]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("short");
  });

  it("skips empty patterns", () => {
    const result = compileExtraPatterns(["", "valid"]);
    expect(result).toHaveLength(1);
  });

  it("skips whitespace-only patterns after trim", () => {
    const result = compileExtraPatterns(["   ", "valid"]);
    expect(result).toHaveLength(1);
  });

  it("skips potential ReDoS patterns", () => {
    // Pattern with nested quantifiers like (.+)+
    const result = compileExtraPatterns(["(.+)+", "safe-pattern"]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("safe-pattern");
  });

  it("skips patterns with (.*)+", () => {
    const result = compileExtraPatterns(["(.*)+", "valid"]);
    expect(result).toHaveLength(1);
  });

  it("allows patterns without nested quantifiers", () => {
    const result = compileExtraPatterns(["normal.*pattern", "word+"]);
    expect(result).toHaveLength(2);
  });

  it("handles special regex characters in string patterns", () => {
    // String patterns are compiled as regex, so special chars need escaping
    const result = compileExtraPatterns(["file\\.txt"]);
    expect(result).toHaveLength(1);
    expect(result[0].test("file.txt")).toBe(true);
  });
});
