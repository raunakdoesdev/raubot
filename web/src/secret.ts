import "./app.css";
import { mount } from "svelte";
import Secret from "./Secret.svelte";

mount(Secret, { target: document.getElementById("app")! });
