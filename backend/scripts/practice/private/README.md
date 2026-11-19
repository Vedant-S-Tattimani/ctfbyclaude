# Private practice challenges

Put new practice challenges here when their flags should stay secret. Git ignores every file in this
folder except this README, so these challenges are never pushed to GitHub (the repository is public).

`npm run seed:practice` loads every `*.js` file in this folder and adds its challenges to the Practice Arena,
alongside the public ones in `../challenges-a.js` and `../challenges-b.js`. `npm test` solves them too,
when the file exports solvers.

**Back these files up somewhere private** (a password manager, a private repo, a drive). If they're lost,
the flags are lost with them; the database only keeps hashes.

## File format

Each file exports `challenges`: builder functions that return a challenge.
It can also export `solvers`, keyed by challenge name, to let the tests check the challenge is solvable
without reading `challenge.flag`.

```js
// backend/scripts/practice/private/my-challenges.js
export const challenges = [
  () => ({
    name: 'Hex Marks the Spot',        // unique across all practice challenges
    category: 'misc',                  // web crypto rev pwn forensics osint misc hardware stego network
    difficulty: 1,                     // 1 = 50 pts, 2 = 100, 3 = 200, 4 = 300, 5 = 400
    flag: 'FSOC{replace_me}',
    ci: false,                         // true = case-insensitive flag
    description: `Decode this: \`${Buffer.from('FSOC{replace_me}').toString('hex')}\``,
    hint: 'Two hex digits make one byte.',
    files: [],                         // [{ name: 'file.bin', data: Buffer }]
  }),
];

export const solvers = {
  'Hex Marks the Spot': (c) => Buffer.from(c.description.match(/`([0-9a-f]+)`/)[1], 'hex').toString(),
};
```

Then run `npm run seed:practice` (only challenges that aren't in the database yet are added) and `npm test`.
