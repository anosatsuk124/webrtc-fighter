use rhai::packages::{Package, StandardPackage};
use rhai::{AST, Dynamic, Engine, Scope};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

#[derive(serde::Serialize, Clone)]
#[serde(tag = "t")]
enum Cmd {
    #[serde(rename = "move")]
    Move { dx: i64 },
    #[serde(rename = "anim")]
    Anim { name: String },
}

thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(setup_engine());
    static AST_OBJ: RefCell<Option<AST>> = const { RefCell::new(None) };
    static SCOPE: RefCell<Scope<'static>> = RefCell::new(Scope::new());
    static CMDS: RefCell<Vec<Cmd>> = const { RefCell::new(Vec::new()) };
    static LAST_ERR: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn setup_engine() -> Engine {
    // Start from raw engine and add the standard package explicitly to avoid
    // pulling in extra host imports. This enables operators like '&' and helpers like 'is_def'.
    let mut eng = Engine::new_raw();
    eng.register_global_module(StandardPackage::new().as_shared_module());
    // Capability-based API: record commands
    eng.register_fn("move", |dx: i64| {
        CMDS.with(|c| c.borrow_mut().push(Cmd::Move { dx }));
    });
    eng.register_fn("anim_play", |name: &str| {
        CMDS.with(|c| {
            c.borrow_mut().push(Cmd::Anim {
                name: name.to_string(),
            })
        });
    });
    eng.set_max_operations(50_000);
    eng
}

#[wasm_bindgen]
pub fn load_script_source(src: &str) -> bool {
    match ENGINE.with(|e| e.borrow().compile(src)) {
        Ok(ast) => {
            // Reset scope and run top-level statements once to allow global init blocks
            // like `if !is_def(state) { ... }` to execute before the first tick.
            let mut scope = Scope::new();
            let res = ENGINE.with(|e| e.borrow().eval_ast_with_scope::<Dynamic>(&mut scope, &ast));
            match res {
                Ok(_) => {
                    SCOPE.with(|s| *s.borrow_mut() = scope);
                    AST_OBJ.with(|o| *o.borrow_mut() = Some(ast));
                    true
                }
                Err(err) => {
                    LAST_ERR.with(|le| *le.borrow_mut() = Some(format!("{}", err)));
                    false
                }
            }
        }
        Err(err) => {
            LAST_ERR.with(|le| *le.borrow_mut() = Some(format!("{}", err)));
            false
        }
    }
}

#[wasm_bindgen]
pub fn tick_and_get_commands(frame: u32, input_mask: u32) -> String {
    let ok = ENGINE.with(|e| {
        AST_OBJ.with(|o| {
            if let Some(ast) = o.borrow().as_ref() {
                let mut scope = SCOPE.with(|s| s.borrow().clone());
                scope.set_or_push("INPUT", input_mask as i64);
                let r = e.borrow().call_fn::<Dynamic>(
                    &mut scope,
                    ast,
                    "tick",
                    (frame as i64, input_mask as i64),
                );
                SCOPE.with(|s| *s.borrow_mut() = scope);
                match r {
                    Ok(_) => true,
                    Err(err) => {
                        LAST_ERR.with(|le| *le.borrow_mut() = Some(format!("{}", err)));
                        false
                    }
                }
            } else {
                false
            }
        })
    });
    let out = CMDS.with(|c| {
        let v = c.borrow().clone();
        c.borrow_mut().clear();
        v
    });
    if ok {
        serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
    } else {
        "[]".into()
    }
}

#[wasm_bindgen]
pub fn take_last_error() -> String {
    LAST_ERR.with(|le| le.borrow_mut().take().unwrap_or_default())
}
