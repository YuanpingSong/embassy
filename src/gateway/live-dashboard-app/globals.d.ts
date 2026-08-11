// Ambient declarations for the live dashboard app bundle.
//
// ReactDOM's @types global namespace predates createRoot, so the minimal
// surface the app uses is declared here instead of adding @types/react-dom.
declare namespace ReactDOM {
  interface Root {
    render(children: React.ReactNode): void;
    unmount(): void;
  }
  function createRoot(container: Element): Root;
}
