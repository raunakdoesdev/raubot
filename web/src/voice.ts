import "./app.css";
import { mount } from "svelte";
import Voice from "./Voice.svelte";

mount(Voice, { target: document.getElementById("app")! });
