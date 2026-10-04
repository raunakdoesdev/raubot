import "./app.css";
import { mount } from "svelte";
import Settings from "./Settings.svelte";

mount(Settings, { target: document.getElementById("app")! });
