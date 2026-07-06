import { describe, it, expect } from "vitest";
import { convertUnit, evalExpression } from "./builtin.js";

describe("evalExpression", () => {
  it("does basic arithmetic with precedence", () => {
    expect(evalExpression("1 + 2 * 3")).toBe(7);
    expect(evalExpression("(1 + 2) * 3")).toBe(9);
    expect(evalExpression("10 - 4 - 3")).toBe(3); // left-associative
    expect(evalExpression("2 * 3 % 4")).toBe(2);
  });

  it("handles unary minus and signed exponents", () => {
    expect(evalExpression("-5")).toBe(-5);
    expect(evalExpression("-2 ** 2")).toBe(-4); // ** binds tighter than unary minus
    expect(evalExpression("2 ** -2")).toBe(0.25);
    expect(evalExpression("--3")).toBe(3);
  });

  it("is right-associative for **", () => {
    expect(evalExpression("2 ** 3 ** 2")).toBe(512); // 2 ** (3 ** 2)
  });

  it("parses decimals and scientific notation", () => {
    expect(evalExpression("0.5 + .25")).toBe(0.75);
    expect(evalExpression("1e3 + 1")).toBe(1001);
    expect(evalExpression("1.5e-2")).toBeCloseTo(0.015, 12);
  });

  it("supports whitelisted functions", () => {
    expect(evalExpression("sqrt(16)")).toBe(4);
    expect(evalExpression("abs(-7)")).toBe(7);
    expect(evalExpression("round(2.6)")).toBe(3);
    expect(evalExpression("floor(2.9)")).toBe(2);
    expect(evalExpression("ceil(2.1)")).toBe(3);
    expect(evalExpression("min(3, 1, 2)")).toBe(1);
    expect(evalExpression("max(3, 1, 2)")).toBe(3);
    expect(evalExpression("pow(2, 10)")).toBe(1024);
    expect(evalExpression("log(1000)")).toBeCloseTo(3, 12); // base 10
    expect(evalExpression("ln(e)")).toBeCloseTo(1, 12); // natural
  });

  it("supports constants", () => {
    expect(evalExpression("pi")).toBeCloseTo(Math.PI, 12);
    expect(evalExpression("2 * pi")).toBeCloseTo(2 * Math.PI, 12);
    expect(evalExpression("e")).toBeCloseTo(Math.E, 12);
  });

  it("evaluates a nested compound expression", () => {
    expect(evalExpression("(2 + 3) * sqrt(16) / 2 ** 2")).toBe(5);
  });

  it("rejects malformed or unsafe input", () => {
    expect(() => evalExpression("")).toThrow();
    expect(() => evalExpression("1 +")).toThrow();
    expect(() => evalExpression("(1 + 2")).toThrow();
    expect(() => evalExpression("1 2")).toThrow();
    expect(() => evalExpression("foo(2)")).toThrow(); // unknown function
    expect(() => evalExpression("x + 1")).toThrow(); // unknown identifier
    expect(() => evalExpression("process")).toThrow();
    expect(() => evalExpression("1 & 2")).toThrow(); // unsupported operator
    expect(() => evalExpression("sqrt(1, 2)")).toThrow(); // wrong arity
    expect(() => evalExpression("pow(2)")).toThrow(); // wrong arity
    expect(() => evalExpression("1 / 0")).toThrow(); // non-finite result
  });
});

describe("convertUnit", () => {
  it("converts length", () => {
    expect(convertUnit(1, "km", "m")).toBeCloseTo(1000, 9);
    expect(convertUnit(1, "mi", "km")).toBeCloseTo(1.609344, 9);
    expect(convertUnit(12, "in", "ft")).toBeCloseTo(1, 9);
    expect(convertUnit(100, "cm", "m")).toBeCloseTo(1, 9);
  });

  it("converts mass", () => {
    expect(convertUnit(1, "kg", "g")).toBeCloseTo(1000, 9);
    expect(convertUnit(1, "lb", "oz")).toBeCloseTo(16, 6);
    expect(convertUnit(1000, "mg", "g")).toBeCloseTo(1, 9);
  });

  it("converts temperature (affine)", () => {
    expect(convertUnit(0, "c", "f")).toBeCloseTo(32, 9);
    expect(convertUnit(100, "c", "f")).toBeCloseTo(212, 9);
    expect(convertUnit(0, "c", "k")).toBeCloseTo(273.15, 9);
    expect(convertUnit(32, "f", "c")).toBeCloseTo(0, 9);
    expect(convertUnit(300, "k", "c")).toBeCloseTo(26.85, 9);
  });

  it("converts volume", () => {
    expect(convertUnit(1, "l", "ml")).toBeCloseTo(1000, 9);
    expect(convertUnit(1, "gal", "qt")).toBeCloseTo(4, 6);
    expect(convertUnit(2, "cup", "l")).toBeCloseTo(0.473176473, 9);
  });

  it("converts data (binary/1024-based)", () => {
    expect(convertUnit(1, "kb", "b")).toBeCloseTo(1024, 9);
    expect(convertUnit(1, "gb", "mb")).toBeCloseTo(1024, 9);
    expect(convertUnit(1, "tb", "gb")).toBeCloseTo(1024, 9);
  });

  it("converts time", () => {
    expect(convertUnit(1, "h", "min")).toBeCloseTo(60, 9);
    expect(convertUnit(1, "day", "h")).toBeCloseTo(24, 9);
    expect(convertUnit(1, "week", "day")).toBeCloseTo(7, 9);
  });

  it("is case-insensitive and trims units", () => {
    expect(convertUnit(1, " KM ", "M")).toBeCloseTo(1000, 9);
  });

  it("round-trips", () => {
    expect(convertUnit(convertUnit(5, "mi", "km"), "km", "mi")).toBeCloseTo(5, 9);
  });

  it("throws on dimension mismatch", () => {
    expect(() => convertUnit(1, "km", "kg")).toThrow(/mismatch/i);
    expect(() => convertUnit(1, "c", "m")).toThrow(/mismatch/i);
    expect(() => convertUnit(1, "s", "l")).toThrow(/mismatch/i);
  });

  it("throws on unknown units", () => {
    expect(() => convertUnit(1, "km", "furlong")).toThrow(/unknown unit/i);
    expect(() => convertUnit(1, "parsec", "m")).toThrow(/unknown unit/i);
  });

  it("throws on a non-finite value", () => {
    expect(() => convertUnit(Number.NaN, "km", "m")).toThrow();
  });
});
