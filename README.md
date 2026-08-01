# Bubblesort

A daily browser game: order five GitHub repositories by a rotating statistic.

The application runs on [Lakebed](https://lakebed.app). Install dependencies
with `npm install`, then use `npm run dev` once local puzzle data exists.

## Puzzle data

The canonical dataset and calendar are intentionally absent from Git. They
contain future answers and must remain private:

- `server/data/repos.gen.ts`
- `server/data/calendar.gen.ts`
- `data/calendar-audit.txt`
- rendered files under `design/`

To build a new, independent calendar:

1. Run `npm run fetch` and `npm run dataset`.
2. Copy `.env.calendar.example` to `.env.calendar.local` and supply two private
   unsigned 32-bit seeds.
3. Run `npm run calendar` and review `data/calendar-audit.txt`.
4. Run `npm run verify` and `npm run dev`.

Lakebed deploys from the working tree, so the ignored generated files are still
included in a deployment. A clone of this repository cannot deploy the
canonical game unless its private puzzle material and seeds are supplied
separately.
