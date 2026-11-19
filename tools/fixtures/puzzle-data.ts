// Synthetic input for verification only. These are invented repositories and
// values, not a replacement for the private production snapshot or calendar.

import { dayIndexFrom } from "../../shared/format.ts";
import type { CalendarDay, Repo } from "../../shared/types.ts";
import { answerOrder, statSchedule } from "../generate.ts";

export const REPOS: Repo[] = Array.from({ length: 5 }, (_, index) => ({
  slug: `fixture/repository-${index + 1}`,
  stars: 16_000 / 2 ** index,
  contributors: 1_600 / 2 ** index,
  openIssues: 800 / 2 ** index,
  commits: 160_000 / 2 ** index,
  firstCommitMs: Date.UTC(2000 + index * 2, 0, 1)
}));

// Keep enough history to exercise rotation/archives and at least two months
// ahead of the execution date, even after the original launch calendar ends.
const days = Math.max(1_100, dayIndexFrom(Date.now()) + 65);
const schedule = statSchedule(days, 0xbabb1e);

export const CALENDAR: CalendarDay[] = schedule.map((stat, day) => ({
  day,
  stat,
  answer: answerOrder(REPOS, [0, 1, 2, 3, 4], stat),
  // A fixed derangement makes every opening slot wrong. The suite's repeated
  // wrong guess [1, 0, 2, 3, 4] remains a loss, whatever today's selected stat.
  shown: [1, 2, 3, 4, 0]
}));
