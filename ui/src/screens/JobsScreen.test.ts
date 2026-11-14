import { describe, expect, it } from "vitest";
import type { Listing } from "../lib/api";
import { STALE_MS, filterListings, isStale, meansUs, updatedLabel } from "./JobsScreen";

const listing = (company: string, role: string, locations: string[], date_posted: string, us = true, advanced_degree = false): Listing => ({
  id: `https://jobs.example.com/${company}`,
  company,
  role,
  locations,
  date_posted,
  url: `https://jobs.example.com/${company}`,
  sources: ["Simplify"],
  first_seen_at: "",
  advanced_degree,
  us,
});

const LISTINGS = [
  listing("Larkspur Freight", "Software Engineer Intern, Platform", ["Chicago, IL"], "2026-11-14"),
  listing("Harbor Analytics", "Data Engineering Intern", ["Boston, MA"], "2026-11-12"),
  listing("Tessellate", "Machine Learning Intern", ["San Francisco, CA", "Remote"], "2026-10-20"),
];
const MORE = [
  ...LISTINGS,
  listing("Maple Systems", "Backend Developer Intern", ["Toronto, ON, Canada"], "2026-11-13", false),
  listing("Tessellate", "Research Intern, PhD", ["San Francisco, CA"], "2026-11-09", true, true),
];
const TODAY = new Date("2026-11-14T15:00:00Z");
const none = { search: "", company: "", role: "", location: "", range: "any", advanced: false };

describe("job filters", () => {
  it("shows everything with no filters", () => {
    expect(filterListings(LISTINGS, none, TODAY)).toHaveLength(3);
  });
  it("searches company, role and location together, ignoring case", () => {
    expect(filterListings(LISTINGS, { ...none, search: "boston" }, TODAY).map((x) => x.company)).toEqual(["Harbor Analytics"]);
    expect(filterListings(LISTINGS, { ...none, search: "INTERN" }, TODAY)).toHaveLength(3);
  });
  it("filters each field on its own and combines them", () => {
    expect(filterListings(LISTINGS, { ...none, company: "tess" }, TODAY).map((x) => x.company)).toEqual(["Tessellate"]);
    expect(filterListings(LISTINGS, { ...none, role: "engineer" }, TODAY)).toHaveLength(2);
    expect(filterListings(LISTINGS, { ...none, location: "remote" }, TODAY).map((x) => x.company)).toEqual(["Tessellate"]);
    expect(filterListings(LISTINGS, { ...none, role: "engineer", location: "chicago" }, TODAY)).toHaveLength(1);
  });
  it("keeps listings posted within the chosen range", () => {
    expect(filterListings(LISTINGS, { ...none, range: "1" }, TODAY).map((x) => x.company)).toEqual(["Larkspur Freight"]);
    expect(filterListings(LISTINGS, { ...none, range: "7" }, TODAY)).toHaveLength(2);
    expect(filterListings(LISTINGS, { ...none, range: "30" }, TODAY)).toHaveLength(3);
  });
});

describe("US and degree filters", () => {
  it("United States matches every US listing, whatever city it names", () => {
    for (const q of ["United States", "united states", "USA", "US", " u.s. "]) {
      expect(filterListings(MORE, { ...none, location: q }, TODAY).map((x) => x.company), q).toEqual(["Larkspur Freight", "Harbor Analytics", "Tessellate"]);
    }
    expect(meansUs("us east")).toBe(false);
    expect(filterListings(MORE, { ...none, location: "toronto" }, TODAY).map((x) => x.company)).toEqual(["Maple Systems"]);
  });
  it("hides PhD and Master's roles until asked", () => {
    expect(filterListings(MORE, none, TODAY).some((x) => x.advanced_degree)).toBe(false);
    expect(filterListings(MORE, { ...none, advanced: true }, TODAY).filter((x) => x.advanced_degree)).toHaveLength(1);
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-11-14T15:00:00Z");
  it("says how long ago the listings were loaded", () => {
    expect(updatedLabel(null, now)).toBe("Not loaded yet");
    expect(updatedLabel("2026-11-14T14:59:40Z", now)).toBe("Updated just now");
    expect(updatedLabel("2026-11-14T14:59:00Z", now)).toBe("Updated 1 minute ago");
    expect(updatedLabel("2026-11-14T14:48:00Z", now)).toBe("Updated 12 minutes ago");
    expect(updatedLabel("2026-11-14T12:00:00Z", now)).toBe("Updated 3 hours ago");
    expect(updatedLabel("2026-11-12T12:00:00Z", now)).toBe("Updated 2 days ago");
  });
  it("refreshes on open after an hour, or when nothing was loaded", () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date(now - STALE_MS + 60_000).toISOString(), now)).toBe(false);
    expect(isStale(new Date(now - STALE_MS - 60_000).toISOString(), now)).toBe(true);
  });
});
