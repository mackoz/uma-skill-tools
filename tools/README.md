# Command status

Run TypeScript tools through the repository-local dependency, for example `npx ts-node tools/skillgrep.ts --help` from the repo root (or `npx ts-node skillgrep.ts --help` from this directory).

At commit `f6fb9d0`, `skillgrep.ts` and `compare.ts` compile and show their help normally. `gain.ts`, `dump.ts`, and `speedguts.ts` are currently blocked before execution by pre-existing TypeScript/API drift: the first two still construct `RaceSolver` with the removed `pacer` property, `dump.ts` also references removed pacing fields, and `speedguts.ts` reaches the dangling `EnhancedHpPolicy` import through `RaceSolverBuilder`. Their sections below document the intended interfaces, but those commands need code repair before they can be used. See `../CLAUDE.md` for the complete 14-error typecheck baseline.

# skillgrep.ts

Search skills by name or condition. For conditions it may be either just a condition name (e.g. phase_random) or a full condition specification with & and/or @. Order doesn't matter, so phase_random==1&running_style==3 matches running_style==3&phase_random==1. Partial condition names don't work.

Has a number of options controlling the output and what is searched. Run `npx ts-node skillgrep.ts --help` for a list.

Notably it searches conditions by default and you have to use the `-N` or `--name` option to search skill names. Unlike conditions names can be a partial match and can be given in English or Japanese. Romanized Japanese does not match.

# gain.ts

Reads an uma definition file and takes skills on the command line and simulates a race with and without the specified skills to report statistics about their effects in terms of バ身 gain. See nige.json, senkou.json, etc to get an idea of the definition format.

Has a fairly large number of options, but the most important are:

- `-c, --course <course id>` Required. Finding the ID for a given racecourse is kind of annoying, I just look in the course_data.json file. Sorry about that.
- `-m, --mood -2|-1|0|+1|+2` The uma's mood, where -2 to +2 correspond with 絶不調 to 絶好調. Defaults to +2.
- `-g, --ground good|yielding|soft|heavy` Ground condition. The choices correspond to 良, 稍重, 重, 不良.
- `-s, --skill <skill id>` or `--skills <comma-separated list of skill ids>` The skills to test. You can specify `-s` multiple times; this is equivalent to passing a comma-separated list of skills to `--skills`. Note that this tests the combination of skills, not each one separately. Run gain.ts multiple times for that. You can use skillgrep.ts with the `-d` option to find the ID for a skill, or GameTora shows them if you enable the ‘Show skill IDs’ setting.
- `--nsamples <integer>` Number of times to simulate races. Min/max/median/mean バ身 gain is reported from the results. Defaults to 500. You may want to increase it if you're comparing multiple random skills at once, to try to cover more pairs of random activation points. The simulator is relatively fast.
- `--dump` Intended to be piped into histogram.py to show a histogram of バ身 gain instead of just reporting a summary.

Once its API drift is repaired, run `npx ts-node gain.ts --help` for a full list.

Any skills you want both simulations to have should be specified in the uma definition file. There is a default file for each strategy:

- nige.json has inherited アングリング×スキーミング
- senkou.json has inherited つぼみ、ほころぶ時
- sasi.json has inherited レッツ・アナボリック！
- oikomi.json has 直線一気

To make updates easier it's probably best to copy the files if you want to modify them.

# dump.ts

Simulates a race and collects position/velocity/acceleration data at every timestep. Intended to be piped into plot.py.

Shares most of its options with gain.ts, including the same format for specifying umas. Unlike gain.ts, there is no difference between skills specified in the definition file and skills passed on the command line.

gain.ts output includes the lines `min configuration: ` and `max configuration: ` followed by a base64-encoded string. The `-C, --configuration` option of dump.ts can be used to load these to visualize the minimum and maximum samples from gain.ts. When doing this make sure to pass the exact same course, uma definition, and set of skills to gain.ts and dump.ts or the output will be meaningless.

# compare.ts

Takes two uma definition files and runs simulations with each of them to compare the results.

This is intended for comparisons that can't be made with gain.ts, for example comparing umas with different stats or comparing completely different sets of skills. Run `npx ts-node compare.ts --help` for options, but they're mostly the same as gain.ts.

# plot.py

Takes the output of dump.ts and plots it alongside the course features. Requires matplotlib to be installed.

Has a lot of options. Run `python plot.py --help` to see them. In most cases you probably want something like `-v -o 15 -hcspk`.

# histogram.py

Pipe a JSON array into it to see a histogram. Intended for use with the `--dump` option of gain.ts. Run `python histogram.py --help` for options. You probably want `-C` in most cases. Also requires matplotlib.

# speedguts.ts / speedguts_colormesh.py

Used for calculating the difference between various combinations of speed and guts stats. Besides the usual course/mood/ground options, it takes:

- `--speed-range <lower,upper>` and `--guts-range`: the ranges of speed and guts to test as a pair of integers `lower,upper` (inclusive of both)
- `--step <integer>` increments within the ranges to test
- `--standard <speed,guts>` pair of speed and guts to compare the other combinations with to report バ身 gain

The output of speedguts.ts is intended to be piped into speedguts_colormesh.py for visualization.

# replay/parseReplay.ts

Decodes hakuraku-format saved-race JSON (the Global-client `simDataBase64` blob: per-frame
distance/speed/HP/lane/blocking/temptation for every horse, per-horse finish results, and the
full skill/event stream) into plain TypeScript objects, for checking this engine against real
game output. Built for [PIPE-21](../../plans/work-queue/in-progress/pipe-21.md) in
`uma-tools-plans` — see that ticket for the corpus this was verified against and what it's being
used for. `npx ts-node tools/replay/parseReplay.ts <race.json>` prints a summary (header fields,
horse results, per-horse skill activation timeline); `npx ts-node tools/replay/parseReplay.ts
--all <dir>` sweeps a directory and reports parse success/failure per file. `deserialize()`,
`parseReplayFile()`, and `skillTimeline()` are also exported for use from other scripts. Only
implements the Global-client parser path (hakuraku also has a separate JP-client parser this
doesn't port — every file this was tested against decoded cleanly on the Global path, so the JP
path wasn't needed).

# replay/replayDiff.ts

Builds all 9 horses from a single decoded replay (via `parseReplay.ts`), pins every recorded
skill activation to its replay position via `RaceSolverBuilder.addSkillAtPosition`, cross-`initUmas()`s
them the way `umalator/compare.ts` does with a real pair, and diffs simulated distance/speed/HP
against the replay's own recorded values, sampled at the replay's (uneven) timestamps. `npx
ts-node tools/replay/replayDiff.ts <race.json>` prints per-horse error stats. Runs under plain
`ts-node` — the `RaceSolverBuilder.ts` per-file typecheck failures this used to hit (HP-5's dead
`EnhancedHpPolicy` import, PIPE-22's missing `HorseDesc.skills` field) are both fixed. Also built
for PIPE-21; documents its own modeling simplifications (dropped never-activated skills, no cross-horse
debuff targeting, static order assumption) in its file header — read those before trusting a
diff number at face value.

# replay/measureDownhill.ts

Corpus-level measurement, no simulator run: cross-checks the engine's downhill accel-mode HP
and speed effects against real replay data over a directory of same-course replays, using
hakuraku's own HP-drain-based downhill-mode detector (independent of the speed effect being
measured). `npx ts-node tools/replay/measureDownhill.ts <dir>`. Written for PIPE-21's SPD-7
measurement pass; documents in its own comments why the speed-side result is confounded (other
low-HP-consumption states like PaceDown get caught by the same threshold) and shouldn't be
read as decisive on its own.

# make_skill_data.pl and make_skillnames.pl

Used to generate the data/skill_data.json and data/skillnames.json files. make_skill_data.pl takes a path to master.mdb; make_skillnames.pl takes two positional args, a path to master.mdb (for JP names) followed by a file obtained from a GameTora quasi-API thing (for EN names).
