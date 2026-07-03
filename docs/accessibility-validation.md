# Accessibility Validation Checklist

Use this checklist before pilot launch and after any substantial UI change to intake, project decision, or review workflows. Record only the validation date, environment, browser and assistive technology versions, tester role, result, and approved issue links.

## Automated Gate

- Run `npm test` and confirm `test/accessibility-regression.test.mjs` passes.
- Run `npm run check`.
- Treat failures in labeled controls, modal naming, live regions, focus visibility, positive `tabindex`, or inline click handlers as launch-blocking until fixed.

## Keyboard Checks

- Intake: from the browser address bar, tab through main navigation, `Submit a problem`, all intake fields, person search fields, person result selects, selection gate checkboxes, `Save draft`, and `Submit for triage`.
- Intake: verify the visible focus indicator is present on every link, button, input, textarea, select, and validation summary.
- Intake: save a draft, resume it, and submit it without using a mouse. Confirm focus returns to the working title when a draft is resumed and status text updates are visible.
- Decision: open a project brief from the portfolio, close it with the close button and `Esc`, then reopen it and complete available decision actions using only the keyboard.
- Decision: request a decision with an empty rationale and confirm the toast announces the blocking message without moving focus unpredictably.
- Review: complete a required review from the project brief using only keyboard navigation. Confirm missing evidence-link validation is reachable and the successful completion message appears.

## Screen Reader Checks

- Intake: with VoiceOver, NVDA, or JAWS, confirm the intake region is announced as `New project intake`, each field has a meaningful label, and the saved-draft and people-picker status regions announce changes.
- Decision: confirm the project brief dialog announces its title, has one close control named `Close details`, and does not allow virtual cursor navigation behind the modal while open.
- Decision: confirm approval, handoff, and decision-request controls announce their visible labels and required text fields.
- Review: confirm the required reviews section announces each review type, status, evidence-link field, and completion button.
- Global: confirm toast and form-status updates are announced without exposing sensitive project content beyond approved metadata already visible on screen.

## Evidence

For each run, link the approved validation record to the release or pilot-readiness checklist. Include blockers, owner, fix link, retest date, and final result.
