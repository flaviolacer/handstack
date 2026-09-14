import { validateDocumentation, validateGovernance } from './index.js';

const documentation = validateDocumentation();
const governance = validateGovernance();
const errors = [...documentation.errors, ...governance.errors];
if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation valid: ${String(documentation.articleCount)} localized articles, ${String(governance.requirementCount)} requirements, ${String(governance.contextualHelpTargetCount)} contextual-help targets.`,
  );
}
