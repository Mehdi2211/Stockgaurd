import { dtToMillimes, formatMillimes } from "./money";

describe("dtToMillimes", () => {
  test("entiers", () => {
    expect(dtToMillimes("200")).toBe(200000);
    expect(dtToMillimes("0")).toBe(0);
    expect(dtToMillimes("1")).toBe(1000);
  });

  test("décimales 1 à 3 chiffres", () => {
    expect(dtToMillimes("0.001")).toBe(1);
    expect(dtToMillimes("0.01")).toBe(10);
    expect(dtToMillimes("0.1")).toBe(100);
    expect(dtToMillimes("12.5")).toBe(12500);
    expect(dtToMillimes("12.05")).toBe(12050);
    expect(dtToMillimes("12.005")).toBe(12005);
    expect(dtToMillimes("230.5")).toBe(230500);
  });

  test("virgule décimale acceptée", () => {
    expect(dtToMillimes("12,5")).toBe(12500);
    expect(dtToMillimes("0,001")).toBe(1);
  });

  test("espaces ignorés", () => {
    expect(dtToMillimes("  42.5  ")).toBe(42500);
  });

  test("négatif refusé par défaut, accepté avec allowNegative", () => {
    expect(dtToMillimes("-5")).toBeNull();
    expect(dtToMillimes("-5", { allowNegative: true })).toBe(-5000);
    expect(dtToMillimes("-0.001", { allowNegative: true })).toBe(-1);
  });

  test("invalide -> null", () => {
    expect(dtToMillimes("")).toBeNull();
    expect(dtToMillimes("   ")).toBeNull();
    expect(dtToMillimes("abc")).toBeNull();
    expect(dtToMillimes("1.0005")).toBeNull(); // 4 décimales
    expect(dtToMillimes("1.2.3")).toBeNull();
    expect(dtToMillimes("--5")).toBeNull();
    expect(dtToMillimes("NaN")).toBeNull();
    expect(dtToMillimes(null)).toBeNull();
    expect(dtToMillimes(undefined)).toBeNull();
    expect(dtToMillimes({})).toBeNull();
  });

  test("pas d'erreur d'arrondi flottant", () => {
    // 0.1 + 0.2 style : la chaîne est parsée exactement
    expect(dtToMillimes("19.99")).toBe(19990);
    expect(dtToMillimes("9999999.999")).toBe(9999999999);
  });
});

describe("formatMillimes", () => {
  test("formatage 3 décimales", () => {
    expect(formatMillimes(200000)).toContain("200");
    expect(formatMillimes(1)).toContain("0,001");
    expect(formatMillimes(-5000)).toContain("5");
    expect(formatMillimes("abc")).toBe("—");
  });
});
