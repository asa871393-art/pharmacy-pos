import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import { PrintHost } from "./components/PrintHost.tsx";
import "./styles.css";
import "./styles/print.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    {/* Outside the app's layout so a printed receipt is the only thing on the page. */}
    <PrintHost />
  </React.StrictMode>,
);
