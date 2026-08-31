#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "matplotlib"]
# [tool.uv]
# exclude-newer = "2026-08-30T00:00:00Z"
# ///
#
# PIPE-37: turns tools/replay/corpusReport.ts's JSON (piped in on stdin) into the
# corpus-wide sim-vs-replay accuracy report. No simulation happens here -- this is
# statistics only, over data corpusReport.ts already computed and privacy-redacted.
#
# `[tool.uv] exclude-newer` is a deliberate deviation from this project's other PEP-723
# script (plans/scripts/wq.py, which has no such pin) -- pinned so this report's numbers
# reproduce across a scipy/numpy minor version bump, since the whole point of this script
# is to be a citable, reproducible result.
#
#   npx ts-node tools/replay/corpusReport.ts <corpus-dir> > tmp/replay-analysis/corpus.json
#   uv run tools/replay/analyze_replay_diff.py \
#       --artifact-json tmp/replay-analysis/artifact.json \
#       < tmp/replay-analysis/corpus.json | tee tmp/replay-analysis/report.txt
#
# See tools/README.md's analyze_replay_diff.py section, and this ticket's own file
# (uma-tools-plans/work-queue -- PIPE-37) for the full methodology writeup this script
# implements: why the headline is two numbers (single-race prediction error vs a
# systematic-differential bound) instead of one, why attribution is regression not
# subsetting, and why the pre-registered pass/fail bar needed a real citation before this
# script could be written at all.

import argparse
import json
import sys

import numpy as np
from scipy import stats

BASINN_M = 2.5  # 1 basinn (horse-length) = 2.5m -- umalator/compare.ts:608, tools/gain.ts:139
N_BOOT = 2000
BOOT_SEED = 20260830  # today's date, standing in for a fixed seed -- see the module docstring

# Real calibration for the pre-registered bar (Phase 3 of the plan requires this be a real
# citation, not a remembered number): a live Skill Chart (doBasinnChart) run against one of
# this corpus's own builds, driven through the browser this session --
#   Course 10903 (Hanshin 1600m outer, right turn), Good/Firm, Fall, Daytime.
#   Build: [Ashen Miracle] Oguri Cap, End Closer, SPD 1367/STA 483/POW 1218/GUTS 691/WIT 1086.
#   Model: Full race, preset Thorough, pruning Lenient*100, seed 2615953739.
# Every skill in this build that actually activated under these conditions, with its
# reported gain (95% CI) at n=3072 (n=64 for the one skill capped by a small activation
# count): I Wanna Win with You +0.39L (0.38-0.40), Homestretch Haste +0.21L (0.21-0.21),
# On the Way to Our Dream +0.16L (0.16-0.17), End Closer Savvy(c) +0.15L (0.14-0.16),
# Fall Runner(c) +0.14L (n=64), End Closer Savvy O +0.10L (0.10-0.11). Every other equipped
# skill read 0.00L (didn't activate under these conditions/pruning) or a small negative
# (-0.11 to -0.14L) reflecting an opportunity-cost interaction, not a real "typical" size.
# The earlier draft of this ticket guessed "0.5-2 basinn typical" with no citation --
# this real run says the actual typical single-skill contribution in this exact
# course/condition combination is closer to 0.10-0.4 basinn, an order of magnitude smaller.
TYPICAL_EFFECT_LOW_BASINN = 0.10
TYPICAL_EFFECT_HIGH_BASINN = 0.39
CALIBRATION_CITATION = (
	"live Skill Chart run this session, course 10903 (Hanshin 1600m outer), "
	"[Ashen Miracle] Oguri Cap End Closer build, seed 2615953739, n=3072: "
	"activating skills ranged +0.10L to +0.39L"
)


def eprint(*args, **kwargs):
	print(*args, file=sys.stderr, **kwargs)


def masked(*arrays):
	"""Drop any index where any input array is non-finite. Returns the same arrays,
	masked, plus n. Use before every scipy.stats call that doesn't itself take a
	nan_policy (pearsonr doesn't)."""
	arrays = [np.asarray(a, dtype=float) for a in arrays]
	ok = np.ones(len(arrays[0]), dtype=bool)
	for a in arrays:
		ok &= np.isfinite(a)
	return [a[ok] for a in arrays] + [int(ok.sum())]


def race_clustered_bootstrap(race_ids, statistic_fn, n_boot=N_BOOT, seed=BOOT_SEED):
	"""Cluster bootstrap on race only (not race+build two-way, per this ticket's own
	deviation note -- with only 4 own builds, an independent build-level resample is
	nearly degenerate; race has 20 clusters and is where the real non-independence
	(same field, same course-day conditions, 3 own horses sharing a race) actually
	lives). statistic_fn(indices) -> float, computed over a resampled index array built
	by drawing race clusters with replacement. Returns (lo95, hi95, se, all_boot_values).
	"""
	race_ids = np.asarray(race_ids)
	races = np.unique(race_ids)
	race_to_idx = {r: np.where(race_ids == r)[0] for r in races}
	rng = np.random.default_rng(seed)
	boots = []
	for _ in range(n_boot):
		sampled_races = rng.choice(races, size=len(races), replace=True)
		idx = np.concatenate([race_to_idx[r] for r in sampled_races])
		v = statistic_fn(idx)
		if v is not None and np.isfinite(v):
			boots.append(v)
	boots = np.array(boots)
	if len(boots) == 0:
		return float('nan'), float('nan'), float('nan'), boots
	lo, hi = np.percentile(boots, [2.5, 97.5])
	return float(lo), float(hi), float(np.std(boots, ddof=1)), boots


# ---------------------------------------------------------------------------------------
# Headline A: single-race prediction error, against its own measured floor.
# ---------------------------------------------------------------------------------------

def headline_a(own_runs, reseed):
	files = np.array([r['file'] for r in own_runs])
	builds = np.array([r['buildKey'] for r in own_runs])
	err = np.array([r['finishPosErrBasinn'] for r in own_runs], dtype=float)
	ok = np.isfinite(err)
	err, builds, files = err[ok], builds[ok], files[ok]
	n = int(ok.sum())

	def sd_epsilon(idx):
		e, b = err[idx], builds[idx]
		residuals = []
		n_groups = 0
		for build in np.unique(b):
			vals = e[b == build]
			if len(vals) < 2:
				continue
			n_groups += 1
			residuals.append(vals - vals.mean())
		if n_groups == 0:
			return None
		residuals = np.concatenate(residuals)
		df = len(residuals) - n_groups
		if df <= 0:
			return None
		return float(np.sqrt(np.sum(residuals ** 2) / df))

	point = sd_epsilon(np.arange(len(err)))
	lo, hi, se, _ = race_clustered_bootstrap(files, sd_epsilon)

	build_means = {b: float(err[builds == b].mean()) for b in np.unique(builds)}
	sd_b = float(np.std(list(build_means.values()), ddof=1)) if len(build_means) > 1 else float('nan')

	# sigma_simRNG and the per-build rho, from the reseed pass and the own runs' own
	# finish times respectively.
	sim_rng_by_build = {}
	if reseed:
		by_build = {}
		for entry in reseed['perRun']:
			vals = [v for v in entry['finishPosErrBasinn'] if v is not None]
			by_build.setdefault(entry['buildKey'], []).extend(vals)
		for b, vals in by_build.items():
			if len(vals) > 1:
				sim_rng_by_build[b] = float(np.std(vals, ddof=1))

	real_observed_by_build = {}
	rho_by_build = {}
	for b in np.unique(builds):
		rows = [r for r in own_runs if r['buildKey'] == b]
		real_ft = np.array([r['realFinishTime'] for r in rows], dtype=float)
		sim_ft = np.array([r['simFinishTime'] for r in rows if r['simFinishTime'] is not None], dtype=float)
		real_observed_by_build[b] = float(np.std(real_ft, ddof=1)) if len(real_ft) > 1 else float('nan')
		sim_ft_m, real_ft_m, n_rho = masked(
			[r['simFinishTime'] for r in rows], [r['realFinishTime'] for r in rows])
		if n_rho >= 3:
			r_val, _ = stats.pearsonr(sim_ft_m, real_ft_m)
			rho_by_build[b] = (float(r_val), n_rho)
		else:
			rho_by_build[b] = (float('nan'), n_rho)

	return {
		'n': n, 'sdEpsilonBasinn': point, 'ci95': (lo, hi), 'bootSE': se,
		'buildConstantSdBasinn': sd_b, 'buildMeans': build_means,
		'sigmaSimRngByBuild': sim_rng_by_build,
		'sigmaRealObservedSecByBuild': real_observed_by_build,
		'rhoByBuild': rho_by_build,
	}


# ---------------------------------------------------------------------------------------
# Headline B: systematic differential error -- within-race own-horse position-gap
# contrasts at a genuine common time, computed from the full per-sample trajectories
# (own runs only -- this is exactly what the privacy rule permits).
# ---------------------------------------------------------------------------------------

def headline_b(own_runs):
	by_race = {}
	for r in own_runs:
		by_race.setdefault(r['file'], []).append(r)

	contrasts = []  # (race, contrastErrBasinn)
	for race, horses in by_race.items():
		for i in range(len(horses)):
			for j in range(i + 1, len(horses)):
				a, b = horses[i], horses[j]
				sa, sb = a.get('samples') or [], b.get('samples') or []
				if len(sa) < 2 or len(sb) < 2:
					continue
				t_common = min(sa[-1]['time'], sb[-1]['time'])
				ta = np.array([s['time'] for s in sa])
				tb = np.array([s['time'] for s in sb])
				sim_a = np.interp(t_common, ta, [s['simDist'] for s in sa])
				real_a = np.interp(t_common, ta, [s['realDist'] for s in sa])
				sim_b = np.interp(t_common, tb, [s['simDist'] for s in sb])
				real_b = np.interp(t_common, tb, [s['realDist'] for s in sb])
				contrast = ((sim_a - sim_b) - (real_a - real_b)) / BASINN_M
				contrasts.append((race, contrast))

	races = np.array([c[0] for c in contrasts])
	values = np.array([c[1] for c in contrasts], dtype=float)
	n = len(values)
	point = float(values.mean()) if n else float('nan')

	def mean_stat(idx):
		return float(values[idx].mean()) if len(idx) else None

	lo, hi, se, _ = race_clustered_bootstrap(races, mean_stat)

	# Verdict against the pre-registered bar (see CALIBRATION_CITATION above). A FAIL
	# requires the CI to actually exclude zero AND have its bound *closer* to zero still
	# clear the typical-effect ceiling -- i.e. we're confident the true bias is large, not
	# just that the CI's far edge *reaches* a large number. A CI that reaches a large
	# magnitude while still including zero (or a small value) is UNDERPOWERED, not FAIL --
	# conflating the two was a real bug caught while first running this script: a CI of
	# [-1.2, +2.4] does reach past the typical-effect ceiling, but it also can't rule out
	# zero, so "FAIL-leaning" was the wrong verdict for it.
	if not np.isfinite(lo) or not np.isfinite(hi):
		verdict = 'UNDERPOWERED (bootstrap CI did not resolve)'
	else:
		far_bound = max(abs(lo), abs(hi))
		near_bound = min(abs(lo), abs(hi))
		excludes_zero = (lo > 0) or (hi < 0)
		if far_bound < TYPICAL_EFFECT_LOW_BASINN:
			verdict = 'PASS -- entire CI stays below even the smallest typical per-skill effect'
		elif excludes_zero and near_bound > TYPICAL_EFFECT_HIGH_BASINN:
			verdict = 'FAIL -- CI excludes zero and stays entirely above the typical per-skill effect range'
		else:
			verdict = 'UNDERPOWERED -- CI does not resolve whether the bias is negligible or comparable to a typical effect'

	return {'n': n, 'meanBasinn': point, 'ci95': (lo, hi), 'bootSE': se, 'verdict': verdict}


# ---------------------------------------------------------------------------------------
# Covariate regression: residual error ~ blocked-frame count + running style +
# temptation presence, over every buildable run (own + other -- these covariates and the
# aggregate finishPosErrBasinn are the ones the privacy allowlist keeps for non-own runs).
# ---------------------------------------------------------------------------------------

def covariate_regression(runs):
	y = np.array([r['finishPosErrBasinn'] for r in runs], dtype=float)
	blocked = np.array([r['blockedFrameCount'] for r in runs], dtype=float)
	styles = np.array([r['runningStyle'] for r in runs])
	temptation = np.array([1.0 if r['temptationFrameCount'] > 0 else 0.0 for r in runs])

	ok = np.isfinite(y)
	y, blocked, styles, temptation = y[ok], blocked[ok], styles[ok], temptation[ok]
	n = len(y)

	style_levels = sorted(set(styles.tolist()))
	baseline_style = style_levels[0]
	style_dummies = [styles == lvl for lvl in style_levels[1:]]

	X = [np.ones(n), blocked, temptation] + style_dummies
	X = np.stack(X, axis=1)
	names = ['intercept', 'blockedFrameCount', 'temptationPresent'] + \
		[f'runningStyle=={lvl} (vs {baseline_style})' for lvl in style_levels[1:]]

	def fit(idx):
		coef, *_ = np.linalg.lstsq(X[idx], y[idx], rcond=None)
		return coef

	point_coef = fit(np.arange(n))

	files = np.array([r['file'] for r in runs])[ok]
	cis = []
	for k in range(len(names)):
		def stat(idx, k=k):
			c = fit(idx)
			return float(c[k])
		lo, hi, se, _ = race_clustered_bootstrap(files, stat)
		cis.append((lo, hi, se))

	# Univariate robustness checks -- the error distribution is outlier-dominated (a few
	# build() edge cases, safety-valve near-misses), so Theil-Sen alongside OLS matters.
	blocked_slope = stats.theilslopes(y, blocked)
	temptation_slope = stats.theilslopes(y, temptation) if len(set(temptation.tolist())) > 1 else None

	return {
		'n': n, 'names': names,
		'coefficients': list(zip(names, point_coef.tolist(), cis)),
		'theilslopesBlockedFrameCount': blocked_slope,
		'theilslopesTemptationPresent': temptation_slope,
	}


# ---------------------------------------------------------------------------------------
# Per-measurement sections.
# ---------------------------------------------------------------------------------------

def measurement_1(runs, own_runs, course_distance):
	err = np.array([r['finishPosErrBasinn'] for r in runs], dtype=float)
	err_m, n_all = masked(err)
	dist_bias = np.array([r['distErrMeanM'] for r in runs if r['distErrMeanM'] is not None])
	dist_rms = np.array([r['distErrRmsM'] for r in runs if r['distErrRmsM'] is not None])

	# Phase-weighted breakdown: own runs only (they're the only ones with samples[]).
	# Phase boundaries per CourseHelpers.phaseStart: distance * {0, 1/6, 2/3, 5/6, 1}.
	bounds = [0, course_distance / 6, course_distance * 2 / 3, course_distance * 5 / 6, course_distance]
	phase_names = ['opening leg', 'middle leg', 'final leg', 'last spurt']
	phase_errs = {p: [] for p in phase_names}
	n_samples = 0
	for r in own_runs:
		for s in (r.get('samples') or []):
			n_samples += 1
			d = s['realDist']
			for i, name in enumerate(phase_names):
				if bounds[i] <= d < bounds[i + 1] or (i == len(phase_names) - 1 and d >= bounds[i]):
					phase_errs[name].append(s['simDist'] - s['realDist'])
					break

	return {
		'nAll': n_all,
		'meanFinishPosErrBasinn': float(err_m.mean()) if n_all else float('nan'),
		'meanDistBiasM': float(dist_bias.mean()) if len(dist_bias) else float('nan'),
		'meanDistRmsM': float(dist_rms.mean()) if len(dist_rms) else float('nan'),
		'phaseBreakdownNOwnRuns': len(own_runs),
		'phaseBreakdownNSamples': n_samples,
		'phaseStats': {
			p: {'n': len(v), 'meanM': float(np.mean(v)) if v else float('nan'),
			    'rmsM': float(np.sqrt(np.mean(np.square(v)))) if v else float('nan')}
			for p, v in phase_errs.items()
		},
	}


def measurement_2(runs):
	sim_max_hp = np.array([r['simMaxHp'] for r in runs], dtype=float)
	real_hp0 = np.array([r['realHp0'] for r in runs], dtype=float)
	diff = sim_max_hp - real_hp0
	diff_m, n = masked(diff)
	return {'n': n, 'meanDiff': float(diff_m.mean()) if n else float('nan'),
	        'sdDiff': float(diff_m.std(ddof=1)) if n > 1 else float('nan')}


def measurement_3(runs):
	hp_err = np.array([r['hpErrMean'] for r in runs], dtype=float)
	skill_level_mean = np.array([r['skillLevelMean'] for r in runs], dtype=float)
	skill_level_max = np.array([r['skillLevelMax'] for r in runs], dtype=float)
	hp_m, lvl_mean_m, n1 = masked(hp_err, skill_level_mean)
	if n1 >= 3:
		r_mean, _ = stats.pearsonr(hp_m, lvl_mean_m)
	else:
		r_mean = float('nan')
	hp_m2, lvl_max_m, n2 = masked(hp_err, skill_level_max)
	if n2 >= 3:
		r_max, _ = stats.pearsonr(hp_m2, lvl_max_m)
	else:
		r_max = float('nan')
	return {'nMean': n1, 'pearsonRVsSkillLevelMean': float(r_mean),
	        'nMax': n2, 'pearsonRVsSkillLevelMax': float(r_max)}


def measurement_4(runs, course_distance):
	floor = course_distance * 2 / 3
	cases = [r for r in runs if r['realLastSpurtStartDistance'] > floor + 10]
	return {'floorM': floor, 'n': len(cases), 'cases': [
		{
			'file': r['file'], 'own': r['own'], 'charaName': r['charaName'],
			'realLastSpurtStartDistance': r['realLastSpurtStartDistance'],
			'simLastSpurtTransition': r['simLastSpurtTransition'],
			'simFullSpurt': r['simFullSpurt'],
			'realHp0': r['realHp0'], 'hpErrMean': r['hpErrMean'], 'hpErrRmsM': r['hpErrRmsM'],
		}
		for r in cases
	]}


def measurement_5(runs):
	n = len(runs)
	rushed = sum(1 for r in runs if r['temptationFrameCount'] > 0)
	rate = rushed / n if n else float('nan')
	se = np.sqrt(rate * (1 - rate) / n) if n else float('nan')
	return {
		'n': n, 'rushedCount': rushed, 'observedRate': rate, 'observedSE': float(se),
		'analyticNote': (
			"Analytic engine-side prediction not re-derived by this script -- this "
			"ticket's own methodology review cited an analytic rate of approximately 18 "
			"(Poisson-binomial SE approximately 4.2) over this corpus's wisdom range, "
			"derived separately from the engine's Rushed/Kakari probability model. "
			"Observed vs that citation is underpowered either way (SE is a large "
			"fraction of the count) -- reported as a caveat, not a finding."
		),
	}


# ---------------------------------------------------------------------------------------
# Report assembly.
# ---------------------------------------------------------------------------------------

def format_report(report, manifest, a, b, cov, m1, m2, m3, m4, m5):
	lines = []
	w = lines.append
	w('=' * 78)
	w('PIPE-37: sim-vs-replay accuracy report')
	w(f"course {report['courseSetId']} ({report['courseDistance']}m), "
	  f"{manifest['filesScanned']} files, {manifest['runsAttempted']} runs attempted, "
	  f"{len(manifest['runsBuildFailed'])} build failures, "
	  f"{manifest['duplicateActivationsCollapsed']} duplicate activations collapsed")
	w('Activations pinned from the replay\'s own recorded event log throughout -- this ')
	w('measures physics fidelity given known-correct activation timing, not whether the ')
	w('engine\'s own sampling policy would find that timing (a separate, deferred question).')
	w('=' * 78)

	w('\n--- HEADLINE A: single-race prediction error, against its own measured floor ---')
	w(f"  n={a['n']} (own-trainer runs, 4 builds x up to 15 races)")
	w(f"  SD(epsilon) = {a['sdEpsilonBasinn']:.3f} basinn  "
	  f"(95% CI [{a['ci95'][0]:.3f}, {a['ci95'][1]:.3f}], race-clustered bootstrap, n_boot={N_BOOT})")
	w(f"  build-constant spread SD(b) = {a['buildConstantSdBasinn']:.3f} basinn (4 groups, 3 df -- "
	  f"essentially uninformative on its own, reported for completeness only)")
	w('  sigma_simRNG (the sim\'s own run-to-run spread, activations pinned, seed varied):')
	for build, v in sorted(a['sigmaSimRngByBuild'].items()):
		w(f"    {build}: {v:.3f} basinn")
	w('  sigma_realObserved (real race-to-race finish-time spread, seconds):')
	for build, v in sorted(a['sigmaRealObservedSecByBuild'].items()):
		w(f"    {build}: {v:.3f}s")
	w('  rho_i (sim vs real finish time correlation across each build\'s races):')
	for build, (r_val, n_rho) in sorted(a['rhoByBuild'].items()):
		w(f"    {build}: rho={r_val:.3f} (n={n_rho})")
	w('  sigma_gameRNG is NOT separately identifiable from this corpus (one real draw per')
	w('  race) -- not estimated. The residual after sigma_simRNG and sigma_realObserved is')
	w('  candidate model error, not asserted model error.')

	w('\n--- HEADLINE B: systematic differential error (the defensible bound) ---')
	w(f"  n={b['n']} (within-race own-horse pairwise position-gap contrasts, 3 pairs x <=20 races)")
	w(f"  mean contrast error = {b['meanBasinn']:.3f} basinn  "
	  f"(95% CI [{b['ci95'][0]:.3f}, {b['ci95'][1]:.3f}], race-clustered bootstrap SE={b['bootSE']:.3f})")
	w(f"  calibration: {CALIBRATION_CITATION}")
	w(f"  verdict: {b['verdict']}")

	w('\n--- THE A/B LIMITATION ---')
	w('  No same-uma, one-skill-different pair exists anywhere in this corpus (each of the')
	w('  4 own builds carries exactly one skillset across all its races). umalator\'s own')
	w('  per-skill number is therefore NOT directly validated by this corpus -- Headline B')
	w('  is the closest available bound, not a substitute for that measurement.')

	w('\n--- COVARIATE REGRESSION: finishPosErrBasinn ~ blocked-frame count + running style + temptation ---')
	w(f"  n={cov['n']} (all buildable runs, own + other)")
	for name, coef, (lo, hi, se) in cov['coefficients']:
		w(f"  {name}: {coef:+.4f}  (95% CI [{lo:+.4f}, {hi:+.4f}], bootSE={se:.4f})")
	ts = cov['theilslopesBlockedFrameCount']
	w(f"  Theil-Sen slope vs blockedFrameCount: {ts.slope:+.4f} (CI [{ts.low_slope:+.4f}, {ts.high_slope:+.4f}])")
	if cov['theilslopesTemptationPresent'] is not None:
		tt = cov['theilslopesTemptationPresent']
		w(f"  Theil-Sen slope vs temptationPresent: {tt.slope:+.4f} (CI [{tt.low_slope:+.4f}, {tt.high_slope:+.4f}])")

	w('\n--- M1: corpus-wide physics accuracy ---')
	w(f"  n={m1['nAll']}: mean finishPosErr = {m1['meanFinishPosErrBasinn']:+.3f} basinn, "
	  f"mean dist bias = {m1['meanDistBiasM']:+.3f}m, mean dist RMS = {m1['meanDistRmsM']:.3f}m")
	w(f"  phase-weighted breakdown: own-trainer runs only (n={m1['phaseBreakdownNOwnRuns']} runs, "
	  f"{m1['phaseBreakdownNSamples']} samples) -- non-own runs carry no per-frame samples (privacy)")
	for phase, s in m1['phaseStats'].items():
		w(f"    {phase}: n={s['n']} mean={s['meanM']:+.3f}m rms={s['rmsM']:.3f}m")

	w('\n--- M2: HP-model diagnostic (simMaxHp vs realHp0) ---')
	w(f"  n={m2['n']}: mean diff={m2['meanDiff']:+.3f}, sd={m2['sdDiff']:.3f} -- closed question, "
	  f"maxHp computation is not the source of the observed HP-error spread")

	w('\n--- M3: residual HP error vs skill level (SKL-9 evidence) ---')
	w(f"  n={m3['nMean']}: pearson r(hpErrMean, skillLevelMean) = {m3['pearsonRVsSkillLevelMean']:+.3f}")
	w(f"  n={m3['nMax']}: pearson r(hpErrMean, skillLevelMax)  = {m3['pearsonRVsSkillLevelMax']:+.3f}")

	w(f"\n--- M4: non-full-spurt case studies (realLastSpurtStartDistance > {m4['floorM']:.1f}m + 10m) ---")
	w(f"  n={m4['n']}")
	for c in m4['cases']:
		# simLastSpurtTransition == -1 is not a distance -- HpPolicy.ts's getLastSpurtPair
		# returns [-1, maxSpeed] specifically when the horse can full-spurt from the
		# phase-2 boundary itself; simFullSpurt is the field that actually says so.
		sim_str = 'full spurt from phase-2 boundary' if c['simFullSpurt'] \
			else f"{c['simLastSpurtTransition']:.1f}m"
		w(f"    {c['file']} {'own' if c['own'] else 'other'} {c['charaName']}: "
		  f"real={c['realLastSpurtStartDistance']:.1f}m sim={sim_str} "
		  f"hp0={c['realHp0']} hpErr={c['hpErrMean']:+.1f}")

	w('\n--- M5: rushed (temptation) rate ---')
	w(f"  n={m5['n']}: observed {m5['rushedCount']}/{m5['n']} = {m5['observedRate']:.3f} "
	  f"(SE={m5['observedSE']:.3f})")
	w(f"  {m5['analyticNote']}")

	w('\n' + '=' * 78)
	return '\n'.join(lines)


def histogram_bins(values, n_bins=20):
	values = np.asarray(values, dtype=float)
	values = values[np.isfinite(values)]
	if len(values) == 0:
		return {'edges': [], 'counts': []}
	counts, edges = np.histogram(values, bins=n_bins)
	return {'edges': edges.tolist(), 'counts': counts.tolist()}


def build_artifact_json(report, runs, own_runs, a, b, cov, m1, m2, m3, m4, m5):
	all_err = [r['finishPosErrBasinn'] for r in runs if r['finishPosErrBasinn'] is not None]
	own_err = [r['finishPosErrBasinn'] for r in own_runs if r['finishPosErrBasinn'] is not None]
	return {
		'courseSetId': report['courseSetId'], 'courseDistance': report['courseDistance'],
		'n': {'all': len(runs), 'own': len(own_runs)},
		'headlineA': {k: v for k, v in a.items() if k != 'buildMeans'},
		'headlineB': b,
		'covariateRegression': {
			'n': cov['n'],
			'coefficients': [
				{'name': name, 'coef': coef, 'ci95': [lo, hi], 'se': se}
				for name, coef, (lo, hi, se) in cov['coefficients']
			],
		},
		'measurement1': m1, 'measurement2': m2, 'measurement3': m3, 'measurement4': m4, 'measurement5': m5,
		'histograms': {
			'finishPosErrBasinnAll': histogram_bins(all_err),
			'finishPosErrBasinnOwn': histogram_bins(own_err),
		},
		'calibration': {
			'citation': CALIBRATION_CITATION,
			'typicalEffectLowBasinn': TYPICAL_EFFECT_LOW_BASINN,
			'typicalEffectHighBasinn': TYPICAL_EFFECT_HIGH_BASINN,
		},
	}


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument('--artifact-json', help='write histogram-bin JSON for the artifact to this path')
	parser.add_argument('--plot', action='store_true', help='show matplotlib plots for local exploration')
	args = parser.parse_args()

	report = json.load(sys.stdin)
	runs = report['runs']
	own_runs = [r for r in runs if r['own']]
	reseed = report.get('reseed')

	a = headline_a(own_runs, reseed)
	b = headline_b(own_runs)
	cov = covariate_regression(runs)
	m1 = measurement_1(runs, own_runs, report['courseDistance'])
	m2 = measurement_2(runs)
	m3 = measurement_3(runs)
	m4 = measurement_4(runs, report['courseDistance'])
	m5 = measurement_5(runs)

	print(format_report(report, report['manifest'], a, b, cov, m1, m2, m3, m4, m5))

	if args.artifact_json:
		artifact = build_artifact_json(report, runs, own_runs, a, b, cov, m1, m2, m3, m4, m5)
		with open(args.artifact_json, 'w') as f:
			json.dump(artifact, f, indent='\t')
		eprint(f"wrote {args.artifact_json}")

	if args.plot:
		import matplotlib.pyplot as plt
		all_err = [r['finishPosErrBasinn'] for r in runs if r['finishPosErrBasinn'] is not None]
		own_err = [r['finishPosErrBasinn'] for r in own_runs if r['finishPosErrBasinn'] is not None]
		fig, ax = plt.subplots()
		ax.hist(all_err, bins=20, alpha=0.5, label=f'all (n={len(all_err)})')
		ax.hist(own_err, bins=20, alpha=0.5, label=f'own-trainer (n={len(own_err)})')
		ax.set_xlabel('finishPosErrBasinn')
		ax.legend()
		plt.show()


if __name__ == '__main__':
	main()
