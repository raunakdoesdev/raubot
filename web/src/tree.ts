import "./app.css";
import { mount } from "svelte";
import Tree from "./Tree.svelte";

mount(Tree, { target: document.getElementById("app")! });
