import { parseAmountDT } from "./amount";

// Section 7.9 — parsing des montants (valeurs exactes en millimes).
describe("parseAmountDT", () => {
  test.each([
    ["0", 0],
    ["52", 52000],
    ["12,5", 12500],
    ["0.001", 1],
    ["9999999.999", 9999999999],
    ["  42  ", 42000],       // trim
    ["7,25", 7250],
  ])("valide %s -> %i millimes", (input, expected) => {
    expect(parseAmountDT(input)).toEqual({ millimes: expected });
  });

  test.each([
    "", "-5", "+5", "1e3", "12.3456", "12..5", "1,2,3", "٣", "١٢٣",
    "10000000", "abc", "12,34,5", "--5", "5-",
  ])("invalide %s", (input) => {
    expect(parseAmountDT(input).error).toBeTruthy();
  });

  test("3 décimales max -> message dédié", () => {
    expect(parseAmountDT("12.3456").error).toBe("3 décimales maximum.");
  });

  test("dépassement -> 'Montant trop élevé'", () => {
    expect(parseAmountDT("10000000").error).toBe("Montant trop élevé.");
    expect(parseAmountDT("9999999.9999").error).toBeTruthy();
  });

  test("ajustement : 0 rejeté par l'appelant (parse OK, >0 requis)", () => {
    expect(parseAmountDT("0").millimes).toBe(0); // le routeur exige min:1
  });

  test("réinitialisation : 0 accepté", () => {
    expect(parseAmountDT("0").millimes).toBe(0);
  });
});
