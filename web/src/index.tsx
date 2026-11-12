/* @refresh reload */
import "./app.css";
import lucide from "@iconify-json/lucide/icons.json";
import { addCollection } from "@iconify-icon/solid";
import { Route, Router, useLocation } from "@solidjs/router";
import { lazy, Match, Show, Switch, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { Layout, Toasts } from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Enroll from "./pages/Enroll";
import Login from "./pages/Login";
import { store } from "./store";

// Icônes Lucide embarquées : aucune requête réseau pour les afficher.
addCollection(lucide);

const Transactions = lazy(() => import("./pages/Transactions"));
const Trends = lazy(() => import("./pages/Trends"));
const BudgetPage = lazy(() => import("./pages/Budget"));
const Bourse = lazy(() => import("./pages/Bourse"));
const Categories = lazy(() => import("./pages/Categories"));
const Accounts = lazy(() => import("./pages/Accounts"));
const Devices = lazy(() => import("./pages/Devices"));

/** En local : accès direct. À distance : écran d'ajout d'appareil ou de connexion tant qu'aucune session. */
function Root(props: { children?: JSX.Element }) {
  const location = useLocation();
  return (
    <>
      <Show when={store.me()} fallback={<div class="flex min-h-dvh items-center justify-center"><span class="loading loading-spinner loading-md" /></div>}>
        <Switch>
          <Match when={!store.me()!.local && location.pathname === "/enroll"}>
            <Enroll />
          </Match>
          <Match when={!store.signedIn()}>
            <Login />
          </Match>
          <Match when={true}>
            <Layout>{props.children}</Layout>
          </Match>
        </Switch>
      </Show>
      <Toasts />
    </>
  );
}

render(
  () => (
    <Router root={Root}>
      <Route path="/" component={Dashboard} />
      <Route path="/operations" component={Transactions} />
      <Route path="/budget" component={BudgetPage} />
      <Route path="/tendances" component={Trends} />
      <Route path="/bourse" component={Bourse} />
      <Route path="/categories" component={Categories} />
      <Route path="/comptes" component={Accounts} />
      <Route path="/appareils" component={Devices} />
      <Route path="*" component={Dashboard} />
    </Router>
  ),
  document.getElementById("root")!,
);
