import { CircleAlert, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui";

interface RemotionRouteBoundaryState {
  error: Error | null;
}

/**
 * Keep a malformed legacy project recoverable instead of replacing the entire
 * application with an empty black WebView.
 */
export class RemotionRouteBoundary extends Component<
  { children: ReactNode },
  RemotionRouteBoundaryState
> {
  state: RemotionRouteBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RemotionRouteBoundaryState {
    return {
      error:
        error instanceof Error
          ? error
          : new Error("完整视频工作台遇到未知错误"),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Remotion Studio failed to render", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="project-missing" role="alert">
        <span>
          <CircleAlert size={24} />
        </span>
        <h1>完整视频工作台加载失败</h1>
        <p>{this.state.error.message}</p>
        <Button
          variant="primary"
          icon={<RefreshCw size={15} />}
          onClick={() => window.location.reload()}
        >
          重新加载工作台
        </Button>
      </div>
    );
  }
}
