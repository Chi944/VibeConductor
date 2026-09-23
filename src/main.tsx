import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./fonts.css";
import "./style.css";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="recovery">
        <h1>The studio needs a restart.</h1>
        <p>Your last recovered draft is still in this browser.</p>
        <button onClick={() => location.reload()}>Reload studio</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
