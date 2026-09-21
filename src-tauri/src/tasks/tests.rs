// Integration coverage lives beside provisioning so it can use real git worktrees.
use super::list_catalog;
use crate::config;
use serde_json::json;
use std::fs;

#[test]
fn catalog_hides_children_of_a_tombstoned_project() {
    let root = std::env::temp_dir().join(format!(
        "swath-tombstoned-project-catalog-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    config::initialize(&root).unwrap();
    let conn = config::connection_at(&config::db_path_in(&root).unwrap()).unwrap();
    conn.execute_batch(
        "INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('n','n',2,1,0);
         INSERT INTO projects(id,network_id,name,default_branch,revision,created_at,tombstoned_at) VALUES('p','n','removed','main',2,0,1);
         INSERT INTO tasks(id,project_id,title,assigned_device_id,lifecycle,revision,created_at) VALUES('t','p','hidden','d','active',1,0);
         INSERT INTO task_panes(id,task_id,kind,revision,created_at) VALUES('q','t','piAgent',1,0);",
    )
    .unwrap();
    drop(conn);
    let catalog = list_catalog(&root, &json!({"networkId":"n"})).unwrap();
    assert_eq!(catalog["projects"], json!([]));
    assert_eq!(catalog["tasks"], json!([]));
    assert_eq!(catalog["panes"], json!([]));
    let _ = fs::remove_dir_all(root);
}

#[cfg(test)]
mod integration_tests {
    use crate::git;
    use std::fs;

    #[test]
    fn private_replica_provisions_exact_commit() {
        let root = std::env::temp_dir().join(format!("swath-task-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "one").unwrap();
        let source = git::prepare_project_source(root.to_str().unwrap()).unwrap();
        let commit = git::resolve_ref(&source, "HEAD").unwrap();
        let replica = root.join("replica.git");
        let worktree = root.join("task");
        git::provision_worktree(&source, &replica, &worktree, &commit).unwrap();
        assert_eq!(fs::read_to_string(worktree.join("a.txt")).unwrap(), "one");
        let _ = fs::remove_dir_all(root);
    }
}
