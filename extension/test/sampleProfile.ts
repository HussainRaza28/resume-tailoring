/** One profile for every fill test: two roles, two schools, skills, a language and links. */
import { type Profile, emptyProfile } from "../src/profile";

export const PROFILE: Profile = {
  ...emptyProfile(),
  firstName: "Jordan",
  lastName: "Sample",
  email: "jordan.sample@example.com",
  phone: "555-010-0199",
  street: "100 Main St",
  city: "Springfield",
  state: "Illinois",
  postalCode: "62701",
  linkedin: "https://linkedin.com/in/jordan-sample",
  github: "https://github.com/jordan-sample",
  portfolio: "https://jordan.example",
  websites: [],
  work: [
    {
      title: "Software Engineering Intern",
      company: "Northwind Logistics",
      location: "Chicago, IL",
      current: false,
      start: "2025-06",
      end: "2025-08",
      bullets: [
        "Built a Python service that batches delivery route updates, cutting API calls from 12,000 to 3,000 per day",
        "Added PostgreSQL indexes to the shipment lookup query",
      ],
    },
    {
      title: "Student Technology Assistant",
      company: "Springfield Public Library",
      location: "Springfield, IL",
      current: true,
      start: "2024-01",
      end: "",
      bullets: ["Helped patrons with computer and printer problems at the help desk"],
    },
  ],
  education: [
    {
      school: "State University",
      degree: "Bachelor's Degree",
      field: "Computer Science",
      minor: "Statistics",
      gpa: "3.8",
      start: "2023-09",
      end: "2027-05",
    },
    { school: "Springfield Community College", degree: "Associate's Degree", field: "Mathematics", minor: "", gpa: "3.9", start: "2021-09", end: "2023-05" },
  ],
  skills: ["Python", "PostgreSQL", "Docker"],
  languages: [{ language: "Spanish", level: "Fluent" }],
  workAuthorized: "Yes",
  needsSponsorship: "No",
  startDate: "May 2027",
};
