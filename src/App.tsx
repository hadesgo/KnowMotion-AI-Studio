import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell, ProjectGuard } from "./components/AppShell";
import AnimationEditor from "./pages/AnimationEditor";
import AgentWorkflow from "./pages/AgentWorkflow";
import AudioSubtitles from "./pages/AudioSubtitles";
import Dashboard from "./pages/Dashboard";
import ImageAssets from "./pages/ImageAssets";
import Models from "./pages/Models";
import NewProject from "./pages/NewProject";
import Planning from "./pages/Planning";
import RenderPage from "./pages/RenderPage";
import ScriptEditor from "./pages/ScriptEditor";
import Storyboard from "./pages/Storyboard";
import TimelineEditor from "./pages/TimelineEditor";

function ProjectOutlet() {
  return (
    <ProjectGuard>
      <Outlet />
    </ProjectGuard>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="projects/new" element={<NewProject />} />
        <Route path="settings/models" element={<Models />} />
        <Route path="projects/:projectId" element={<ProjectOutlet />}>
          <Route index element={<Navigate to="plan" replace />} />
          <Route path="plan" element={<Planning />} />
          <Route path="workflow" element={<AgentWorkflow />} />
          <Route path="script" element={<ScriptEditor />} />
          <Route path="storyboard" element={<Storyboard />} />
          <Route path="assets" element={<ImageAssets />} />
          <Route path="animation" element={<AnimationEditor />} />
          <Route path="timeline" element={<TimelineEditor />} />
          <Route path="audio" element={<AudioSubtitles />} />
          <Route path="render" element={<RenderPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
