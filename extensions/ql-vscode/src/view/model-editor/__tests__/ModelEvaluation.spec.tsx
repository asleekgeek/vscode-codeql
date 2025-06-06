import { render as reactRender, screen, waitFor } from "@testing-library/react";
import type { Props } from "../ModelEvaluation";
import { ModelEvaluation } from "../ModelEvaluation";
import { createMockModelEditorViewState } from "../../../../test/factories/model-editor/view-state";
import type { ModeledMethod } from "../../../model-editor/modeled-method";
import { createMethod } from "../../../../test/factories/model-editor/method-factories";
import { createMockVariantAnalysis } from "../../../../test/factories/variant-analysis/shared/variant-analysis";
import { VariantAnalysisStatus } from "../../../variant-analysis/shared/variant-analysis";
import { createSummaryModeledMethod } from "../../../../test/factories/model-editor/modeled-method-factories";

describe(ModelEvaluation.name, () => {
  const method = createMethod();
  const modeledMethodsMap: Record<string, ModeledMethod[]> = {};
  modeledMethodsMap[method.signature] = [createSummaryModeledMethod(method)];

  const render = (props: Partial<Props> = {}) =>
    reactRender(
      <ModelEvaluation
        viewState={createMockModelEditorViewState({ showEvaluationUi: true })}
        modeledMethods={modeledMethodsMap}
        modifiedSignatures={new Set()}
        onStartEvaluation={jest.fn()}
        onStopEvaluation={jest.fn()}
        openModelAlertsView={jest.fn()}
        evaluationRun={undefined}
        {...props}
      />,
    );

  describe("when showEvaluationUi is false", () => {
    it("does not render anything", () => {
      render({
        viewState: createMockModelEditorViewState({ showEvaluationUi: false }),
      });
      expect(screen.queryByText("Evaluate")).not.toBeInTheDocument();
      expect(screen.queryByText("Stop evaluation")).not.toBeInTheDocument();
      expect(screen.queryByText("Evaluation run")).not.toBeInTheDocument();
    });
  });

  describe("when showEvaluationUi is true", () => {
    it("renders evaluation UI with 'Evaluate' button enabled", async () => {
      render();

      const evaluateButton = await screen.findByText("Evaluate");
      expect(evaluateButton).toBeInTheDocument();
      expect(evaluateButton).toBeEnabled();

      expect(screen.queryByText("Stop evaluation")).not.toBeInTheDocument();

      expect(screen.queryByText("Evaluation run")).not.toBeInTheDocument();
    });

    it("disables 'Evaluate' button when there are no custom models", async () => {
      render({
        modeledMethods: {},
      });

      const evaluateButton = await screen.findByText("Evaluate");
      expect(evaluateButton).toBeInTheDocument();
      await waitFor(() => {
        expect(evaluateButton).toBeDisabled();
      });

      expect(screen.queryByText("Stop evaluation")).not.toBeInTheDocument();

      expect(screen.queryByText("Evaluation run")).not.toBeInTheDocument();
    });

    it("disables 'Evaluate' button when there are unsaved changes", async () => {
      render({
        modifiedSignatures: new Set([method.signature]),
      });

      const evaluateButton = await screen.findByText("Evaluate");
      expect(evaluateButton).toBeInTheDocument();
      await waitFor(() => {
        expect(evaluateButton).toBeDisabled();
      });

      expect(screen.queryByText("Stop evaluation")).not.toBeInTheDocument();

      expect(screen.queryByText("Evaluation run")).not.toBeInTheDocument();
    });

    it("renders 'Evaluate' button and 'Evaluation run' link when there is a completed evaluation", async () => {
      render({
        evaluationRun: {
          isPreparing: false,
          variantAnalysis: createMockVariantAnalysis({
            status: VariantAnalysisStatus.Succeeded,
          }),
        },
      });

      const evaluateButton = await screen.findByText("Evaluate");
      expect(evaluateButton).toBeInTheDocument();
      expect(evaluateButton).toBeEnabled();

      expect(screen.queryByText("Evaluation run")).toBeInTheDocument();

      expect(screen.queryByText("Stop evaluation")).not.toBeInTheDocument();
    });

    it("renders 'Stop evaluation' button when there is an in progress evaluation, but no variant analysis yet", async () => {
      render({
        evaluationRun: {
          isPreparing: true,
          variantAnalysis: undefined,
        },
      });

      const stopEvaluationButton = await screen.findByText("Stop evaluation");
      expect(stopEvaluationButton).toBeInTheDocument();
      expect(stopEvaluationButton).toBeEnabled();

      expect(screen.queryByText("Evaluation run")).not.toBeInTheDocument();

      expect(screen.queryByText("Evaluate")).not.toBeInTheDocument();
    });

    it("renders 'Stop evaluation' button and 'Evaluation run' link when there is an in progress evaluation with variant analysis", async () => {
      render({
        evaluationRun: {
          isPreparing: false,
          variantAnalysis: createMockVariantAnalysis({
            status: VariantAnalysisStatus.InProgress,
          }),
        },
      });

      const stopEvaluationButton = await screen.findByText("Stop evaluation");
      expect(stopEvaluationButton).toBeInTheDocument();
      expect(stopEvaluationButton).toBeEnabled();

      expect(screen.queryByText("Evaluation run")).toBeInTheDocument();

      expect(screen.queryByText("Evaluate")).not.toBeInTheDocument();
    });
  });
});
