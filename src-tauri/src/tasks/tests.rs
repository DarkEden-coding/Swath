// Integration coverage lives beside provisioning so it can use real git worktrees.
use super::{apply_task_record, list_catalog};
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

#[test]
fn reconciles_a_committed_pending_task_without_creating_a_duplicate() {
    let root = std::env::temp_dir().join(format!(
        "swath-pending-task-reconcile-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    config::initialize(&root).unwrap();
    let conn = config::connection_at(&config::db_path_in(&root).unwrap()).unwrap();
    conn.execute_batch("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('n','n',2,1,0); INSERT INTO local_device_identity(singleton,id) VALUES(1,'device'); INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES('device','n','Device','device','test','local-device',1,0); INSERT INTO projects(id,network_id,name,repository_source,default_branch,task_order,revision,created_at) VALUES('project','n','Project','/source','main','[]',1,0);").unwrap();
    drop(conn);
    let record = json!({
        "project":{"id":"project","taskOrder":["task"],"revision":2},
        "task":{"id":"task","projectId":"project","title":"Test","assignedDeviceId":"device","executionGeneration":1,"lifecycle":"active","paneOrder":[],"revision":1,"createdAt":10,"baseCommit":"abc","worktreePath":"/worktree","provisioningState":"pending","lastError":null},
        "panes":[]
    });
    apply_task_record(&root, "task", &record).unwrap();
    apply_task_record(&root, "task", &record).unwrap();
    let conn = config::connection_at(&config::db_path_in(&root).unwrap()).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM tasks WHERE id='task'", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT state FROM task_provisioning WHERE task_id='task'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "pending"
    );
    assert_eq!(
        conn.query_row(
            "SELECT revision FROM projects WHERE id='project'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    drop(conn);
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
