/* @refresh reload */
import "./app.css";
import lucide from "@iconify-json/lucide/icons.json";
import { addCollection } from "@iconify-icon/solid";
import { Route, Router } from "@solidjs/router";
import { lazy, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { Layout, Toasts } from "./components/Layout";
import Dashboard from "./pages/Dashboard";

// Icônes Lucide embarquées : aucune requête réseau pour les afficher.
addCollection(lucide);

const Transactions = lazy(() => import("./pages/Transactions"));
const Trends = lazy(() => import("./pages/Trends"));
const Categories = lazy(() => import("./pages/Categories"));
const Accounts = lazy(() => import("./pages/Accounts"));

function Root(props: { children?: JSX.Element }) {
  return (
    <>
      <Layout>{props.children}</Layout>
      <Toasts />
    </>
  );
}

render(
  () => (
    <Router root={Root}>
      <Route path="/" component={Dashboard} />
      <Route path="/operations" component={Transactions} />
      <Route path="/tendances" component={Trends} />
      <Route path="/categories" component={Categories} />
      <Route path="/comptes" component={Accounts} />
      <Route path="*" component={Dashboard} />
    </Router>
  ),
  document.getElementById("root")!,
);
