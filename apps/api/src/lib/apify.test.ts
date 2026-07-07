import { describe, expect, it } from "vitest";
import { normalizeLinkedIn, profileToPromptContext } from "./apify.js";

const URL = "https://www.linkedin.com/in/janedoe";

describe("normalizeLinkedIn", () => {
  it("extracts fields from a common actor shape (fullName/experiences/educations)", () => {
    const p = normalizeLinkedIn(
      {
        fullName: "Jane Doe",
        headline: "Staff Engineer at Acme",
        addressWithCountry: "Berlin, Germany",
        summary: "I build things.",
        experiences: [
          { title: "Staff Engineer", company: "Acme", dateRange: "2021 - Present", description: "Led X." },
        ],
        educations: [{ title: "MIT", subtitle: "BSc", fieldOfStudy: "CS", caption: "2014 - 2018" }],
        skills: ["TypeScript", { name: "Go" }],
      },
      URL,
    );
    expect(p.name).toBe("Jane Doe");
    expect(p.headline).toBe("Staff Engineer at Acme");
    expect(p.location).toBe("Berlin, Germany");
    expect(p.experience).toEqual([
      { title: "Staff Engineer", company: "Acme", dates: "2021 - Present", description: "Led X." },
    ]);
    expect(p.education[0]).toMatchObject({ school: "MIT", degree: "BSc", field: "CS" });
    expect(p.skills).toEqual(["TypeScript", "Go"]);
  });

  it("handles an alternate actor shape (firstName/lastName, positions, occupation)", () => {
    const p = normalizeLinkedIn(
      {
        firstName: "John",
        lastName: "Smith",
        occupation: "Designer",
        positions: [{ position: "Designer", companyName: "Studio", duration: "3 yrs" }],
      },
      URL,
    );
    expect(p.name).toBe("John Smith");
    expect(p.headline).toBe("Designer");
    expect(p.experience[0]).toMatchObject({ title: "Designer", company: "Studio", dates: "3 yrs" });
  });

  it("omits missing fields rather than inventing them", () => {
    const p = normalizeLinkedIn({ name: "No Details" }, URL);
    expect(p.name).toBe("No Details");
    expect(p.experience).toEqual([]);
    expect(p.education).toEqual([]);
    expect(p.skills).toEqual([]);
    const ctx = profileToPromptContext(p);
    // The fact block must instruct against fabrication and not list empty sections.
    expect(ctx).toMatch(/Do NOT invent/i);
    expect(ctx).not.toMatch(/Experience:/);
    expect(ctx).not.toMatch(/Skills:/);
  });
});
