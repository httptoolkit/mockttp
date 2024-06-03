import { URLPattern } from "urlpattern-polyfill";
import { expect } from "./test-utils";
import { shouldPassThrough } from "../src/util/server-utils";

describe("shouldPassThrough", () => {
  it("should return false when passThroughHostnames is empty and interceptOnlyHostnames is undefined", async () => {
    const should = shouldPassThrough("example.org", [], undefined);
    expect(should).to.be.false;
  });

  it("should return true when both lists empty", async () => {
    const should = shouldPassThrough("example.org", [], []);
    expect(should).to.be.true;
  });

  it("should return false when hostname is falsy", () => {
    const should = shouldPassThrough("", [], []);
    expect(should).to.be.false;
  });

  describe("passThroughHostnames", () => {
    it("should return true when hostname is in passThroughHostnames", () => {
      const should = shouldPassThrough(
        "example.org",
        [new URLPattern("https://example.org")],
        undefined
      );
      expect(should).to.be.true;
    });

    it("should return false when hostname is not in passThroughHostnames", () => {
      const should = shouldPassThrough(
        "example.org",
        [new URLPattern("https://example.com")],
        undefined
      );
      expect(should).to.be.false;
    });

    it("should return true when hostname match a wildcard", () => {
      const should = shouldPassThrough(
        "example.org",
        [new URLPattern("https://*.org")],
        undefined
      );
      expect(should).to.be.true;
    });
  });
  describe("interceptOnlyHostnames", () => {
    it("should return false when hostname is in interceptOnlyHostnames", () => {
      const should = shouldPassThrough(
        "example.org",
        [],
        [new URLPattern("https://example.org")]
      );
      expect(should).to.be.false;
    });

    it("should return true when hostname is not in interceptOnlyHostnames", () => {
      const should = shouldPassThrough(
        "example.org",
        [],
        [new URLPattern("https://example.com")]
      );
      expect(should).to.be.true;
    });

    it("should return false when hostname match a wildcard", () => {
      const should = shouldPassThrough(
        "example.org",
        [],
        [new URLPattern("https://*.org")]
      );
      expect(should).to.be.false;
    });
  });
});
