import { describe, expect, it } from "vitest";
import { buildConfigContent, getPlatforms, hasPlatformConfigured, isVersionAtLeast, parseConfiguredTypes, quoteShellPath } from "../../../src/tui/commands/cc-connect.js";

describe("/cc-connect platform catalog", () => {
  it("lists all 20 platforms with unique types", () => {
    const platforms = getPlatforms();
    expect(platforms).toHaveLength(20);
    const types = platforms.map((p) => p.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("includes the platforms added in cc-connect v1.4/v1.5", () => {
    const types = new Set(getPlatforms().map((p) => p.type));
    for (const t of ["matrix", "webex", "max", "googlechat", "cloud_web", "yuanbao", "tuitui", "wps-agentspace"]) {
      expect(types.has(t), `missing platform: ${t}`).toBe(true);
    }
  });

  it("keeps the original platforms", () => {
    const types = new Set(getPlatforms().map((p) => p.type));
    for (const t of ["weixin", "feishu", "telegram", "dingtalk", "discord", "slack", "qq", "wecom"]) {
      expect(types.has(t), `missing platform: ${t}`).toBe(true);
    }
  });
});

describe("parseConfiguredTypes", () => {
  it("returns an empty list for config without platforms", () => {
    expect(parseConfiguredTypes("")).toEqual([]);
    expect(parseConfiguredTypes('[agent]\nworkspace = "~"\n')).toEqual([]);
  });

  it("parses a single platform", () => {
    const content = '[[projects.platforms]]\ntype = "feishu"\n';
    expect(parseConfiguredTypes(content)).toEqual(["feishu"]);
  });

  it("parses multiple platforms", () => {
    const content = [
      "[[projects.platforms]]",
      'type = "feishu"',
      "",
      "[[projects.platforms]]",
      'type = "telegram"',
      "",
    ].join("\n");
    expect(parseConfiguredTypes(content)).toEqual(["feishu", "telegram"]);
  });

  it("ignores commented-out platform types", () => {
    const content = '# [[projects.platforms]]\n# type = "feishu"\n';
    expect(parseConfiguredTypes(content)).toEqual([]);
  });

  it("stops collecting when the next section starts", () => {
    const content = [
      "[[projects.platforms]]",
      'type = "feishu"',
      "",
      "[[projects.agents]]",
      'type = "claudecode"',
      "",
    ].join("\n");
    expect(parseConfiguredTypes(content)).toEqual(["feishu"]);
  });

  it("accepts a section header with a trailing comment", () => {
    const content = '[[projects.platforms]] # 主平台\ntype = "feishu"\n';
    expect(parseConfiguredTypes(content)).toEqual(["feishu"]);
  });

  it("accepts TOML literal (single-quoted) strings", () => {
    const content = "[[projects.platforms]]\ntype = 'feishu'\n";
    expect(parseConfiguredTypes(content)).toEqual(["feishu"]);
  });
});

describe("hasPlatformConfigured", () => {
  it("matches an active platform line", () => {
    const content = '[[projects.platforms]]\ntype = "feishu"\n';
    expect(hasPlatformConfigured(content, "feishu")).toBe(true);
    expect(hasPlatformConfigured(content, "telegram")).toBe(false);
  });

  it("does not match commented-out lines", () => {
    const content = '# [[projects.platforms]]\n# type = "feishu"\n';
    expect(hasPlatformConfigured(content, "feishu")).toBe(false);
  });

  it("does not match a type mentioned inside a comment", () => {
    const content = '# see type = "feishu" above\n\n[agent]\n';
    expect(hasPlatformConfigured(content, "feishu")).toBe(false);
  });

  it("matches a platform line with a trailing comment", () => {
    const content = '[[projects.platforms]]\ntype = "feishu" # primary bot\n';
    expect(hasPlatformConfigured(content, "feishu")).toBe(true);
  });

  it("does not confuse a prefix of a longer type name", () => {
    const content = '[[projects.platforms]]\ntype = "wps-agentspace"\n';
    expect(hasPlatformConfigured(content, "wps")).toBe(false);
    expect(hasPlatformConfigured(content, "wps-agentspace")).toBe(true);
  });

  it("accepts TOML literal (single-quoted) strings", () => {
    const content = "[[projects.platforms]]\ntype = 'feishu'\n";
    expect(hasPlatformConfigured(content, "feishu")).toBe(true);
  });
});

describe("isVersionAtLeast", () => {
  it("compares dotted versions numerically", () => {
    expect(isVersionAtLeast("1.5.0", "1.5.0")).toBe(true);
    expect(isVersionAtLeast("1.5.1", "1.5.0")).toBe(true);
    expect(isVersionAtLeast("1.10.0", "1.5.0")).toBe(true);
    expect(isVersionAtLeast("1.4.1", "1.5.0")).toBe(false);
    expect(isVersionAtLeast("0.9.9", "1.5.0")).toBe(false);
  });

  it("treats a missing version as too old", () => {
    expect(isVersionAtLeast(undefined, "1.5.0")).toBe(false);
    expect(isVersionAtLeast("", "1.5.0")).toBe(false);
  });
});

describe("buildConfigContent", () => {
  const feishu = getPlatforms().find((p) => p.type === "feishu")!;

  it("defaults the permission mode to auto for remote chat", () => {
    const content = buildConfigContent(feishu, "/usr/local/bin/scream stream-json", "/work");
    expect(content).toContain('mode = "auto"');
    expect(content).not.toContain('mode = "default"');
  });

  it("embeds the detected command, work dir, and platform type", () => {
    const content = buildConfigContent(feishu, "/usr/local/bin/scream stream-json", "/work");
    expect(content).toContain("cmd = '/usr/local/bin/scream stream-json'");
    expect(content).toContain("work_dir = '/work'");
    expect(content).toContain('type = "claudecode"');
    expect(content).toContain('type = "feishu"');
  });

  it("quotes values containing a single quote as TOML basic strings", () => {
    // TOML literal strings ('...') cannot contain single quotes at all.
    const content = buildConfigContent(feishu, "/it's/here/scream stream-json", "/work");
    expect(content).toContain(`cmd = "/it's/here/scream stream-json"`);
  });

  it("produces content that parses back via parseConfiguredTypes", () => {
    const content = buildConfigContent(feishu, "scream stream-json", "/work");
    expect(parseConfiguredTypes(content)).toEqual(["feishu"]);
  });
});

describe("quoteShellPath", () => {
  it("double-quotes paths so shells do not split on spaces", () => {
    expect(quoteShellPath("/Applications/My App/scream")).toBe('"/Applications/My App/scream"');
  });

  it("escapes embedded double quotes", () => {
    expect(quoteShellPath('/we"ird/scream')).toBe('"/we\\"ird/scream"');
  });
});
