# Herdr Agent Run admission and termination prototype

> **Throwaway prototype.** This branch exists only as primary evidence for the Wayfinder decision [Prove Herdr Agent Run admission and termination](https://github.com/ewgdg/pi-agent-coordination/issues/17). It is not an implementation base.

## Question

Can a Herdr-hosted runner enforce one live Pi writer per session, prove RPC readiness and intended-session binding, expose process/work/attention as separate observations, interrupt current work semantically, and independently confirm that the exact bound Pi process incarnation exited?

## Run

Requirements: Linux with pidfd support, Herdr `0.7.5`, Pi `0.82.1`, and an active Herdr pane.

```bash
uv run --python /usr/bin/python prototypes/herdr-agent-run/prototype.py
```

The explicit interpreter is required because the current uv-managed Python lacks the standard-library pidfd APIs used by the prototype.

The controller creates a scratch Pi session and a child Herdr pane. The pane hosts a runner that owns Pi's RPC pipes. The runner transfers a pidfd to the controller, so the controller can observe and signal the exact Pi incarnation independently of the pane.

Suggested path through the prototype:

1. Press `a`: the live lease rejects a second cooperating writer before it can spawn Pi.
2. Press `b`: the readiness predicate rejects a deliberately wrong expected session ID.
3. Press `i`, then `r`: attention changes without implying process or work changes.
4. Press `w`, wait for work to become active, then press `s` or `x`: Pi acknowledges semantic steer/abort; abort must settle work while the process remains alive.
5. Press `c`: closing the Herdr pane is not itself accepted as termination or lease-release proof.
6. Press `k`: the controller signals through the retained pidfd, waits for that exact incarnation to exit, then releases the matching fenced lease.
7. Press `q`: clean up any remaining scratch process and pane.

The long-work case makes one normal model request and asks Pi to run `sleep 60`; the remaining cases do not call a model.

## Deliberate limits

- The lease fences cooperating adapter launches, not arbitrary manual `pi` invocations.
- A controller crash leaves the lease stale and fail-closed; recovery policy is a later design decision.
- The prototype proves the direct Pi child only. Descendant containment would require a cgroup or equivalent backend boundary.
- Herdr remains hosting and presentation. Pi RPC remains the control and work-observation seam.
