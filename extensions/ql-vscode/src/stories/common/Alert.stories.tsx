import type { Meta, StoryFn } from "@storybook/react";
import { VscodeButton } from "@vscode-elements/react-elements";

import { VariantAnalysisContainer } from "../../view/variant-analysis/VariantAnalysisContainer";
import { Alert } from "../../view/common";
import { Link } from "../../view/common/Link";

export default {
  title: "Alert",
  component: Alert,
  decorators: [
    (Story) => (
      <VariantAnalysisContainer>
        <Story />
      </VariantAnalysisContainer>
    ),
  ],
} as Meta<typeof Alert>;

const Template: StoryFn<typeof Alert> = (args) => <Alert {...args} />;

export const Warning = Template.bind({});
Warning.args = {
  type: "warning",
  title: "This query found a warning",
  message: (
    <>
      Warning content with <Link>links</Link>
    </>
  ),
};

export const WarningInverse = Template.bind({});
WarningInverse.args = {
  ...Warning.args,
  message: "Warning content",
  inverse: true,
};

export const WarningExample = Template.bind({});
WarningExample.args = {
  type: "warning",
  title: "Query manually stopped",
  message:
    "This query was manually stopped before the analysis completed. Results may be partial.",
};

export const Error = Template.bind({});
Error.args = {
  type: "error",
  title: "This query found an error",
  message: (
    <>
      Error content with <Link>links</Link>
    </>
  ),
};

export const ErrorInverse = Template.bind({});
ErrorInverse.args = {
  ...Error.args,
  message: "Error content",
  inverse: true,
};

export const ErrorExample = Template.bind({});
ErrorExample.args = {
  type: "error",
  title: "Request failed",
  message: (
    <>
      Request to
      https://api.github.com/repos/octodemo/Hello-World/code-scanning/codeql/queries
      failed. <Link>View actions logs</Link> and try running this query again.
    </>
  ),
};

export const ErrorWithButtons = Template.bind({});
ErrorWithButtons.args = {
  type: "error",
  title: "Request failed",
  message:
    "Request to https://api.github.com/repos/octodemo/Hello-World/code-scanning/codeql/queries failed. Try running this query again.",
  actions: (
    <>
      <VscodeButton secondary>View actions logs</VscodeButton>
      <VscodeButton>Retry</VscodeButton>
    </>
  ),
};
